/**
 * Dual-Write Service Example
 * 
 * Example implementation of dual-write pattern for lab orders
 * This demonstrates how to use DualWriteHelper for specific entities
 */

import { FastifyInstance } from 'fastify'
import { createDualWriteHelper, DualWriteResult } from '../lib/dual-write'

/**
 * Lab Order Dual-Write Service
 * 
 * Writes lab orders to both CouchDB (for offline sync) and PostgreSQL (for queries)
 */
export class LabOrderDualWriteService {
  private dualWrite: ReturnType<typeof createDualWriteHelper>

  constructor(fastify: FastifyInstance) {
    this.dualWrite = createDualWriteHelper(fastify, 'lab-orders')
  }

  /**
   * Create a lab order in both databases
   */
  async createLabOrder(data: {
    patientId: string
    testCodeLoinc: string
    status: string
    priority?: string
    facilityId?: string
    practitionerId?: string
  }): Promise<DualWriteResult> {
    const fastify = this.dualWrite.fastify

    // Prepare data for both databases
    const couchData = {
      _id: data.patientId + '_' + Date.now(), // Generate ID
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Write to PostgreSQL
    let postgresId: string | undefined
    try {
      const order = await fastify.prisma.labOrder.create({
        data: {
          patientId: data.patientId,
          testCodeLoinc: data.testCodeLoinc,
          status: data.status,
          priority: data.priority,
          facilityId: data.facilityId,
          practitionerId: data.practitionerId,
        },
      })
      postgresId = order.id
    } catch (error) {
      fastify.log.error(error, 'Failed to create lab order in PostgreSQL')
      throw error
    }

    // Write to CouchDB
    let couchResult
    try {
      couchResult = await this.dualWrite.couch.insert(couchData)
    } catch (error) {
      fastify.log.warn(error, 'Failed to create lab order in CouchDB, but PostgreSQL write succeeded')
      // Don't fail if CouchDB write fails - PostgreSQL is primary
    }

    return {
      postgres: {
        success: true,
        id: postgresId,
      },
      couch: {
        success: !!couchResult,
        id: couchResult?.id,
        rev: couchResult?.rev,
        error: couchResult ? undefined : new Error('CouchDB write failed'),
      },
      overall: true, // PostgreSQL write succeeded
    }
  }

  /**
   * Update a lab order in both databases
   */
  async updateLabOrder(
    id: string,
    data: {
      status?: string
      priority?: string
      collectedAt?: Date
      receivedAt?: Date
      finalizedAt?: Date
    }
  ): Promise<DualWriteResult> {
    const fastify = this.dualWrite.fastify

    // Update PostgreSQL
    try {
      await fastify.prisma.labOrder.update({
        where: { id },
        data: {
          status: data.status,
          priority: data.priority,
          collectedAt: data.collectedAt,
          receivedAt: data.receivedAt,
          finalizedAt: data.finalizedAt,
          updatedAt: new Date(),
        },
      })
    } catch (error) {
      fastify.log.error(error, `Failed to update lab order ${id} in PostgreSQL`)
      throw error
    }

    // Update CouchDB
    let couchResult
    try {
      const couchDoc = await this.dualWrite.couch.get(id).catch(() => null)
      if (couchDoc) {
        const updated = {
          ...couchDoc,
          ...data,
          updatedAt: new Date().toISOString(),
          _rev: couchDoc._rev,
        }
        couchResult = await this.dualWrite.couch.insert(updated)
      }
    } catch (error) {
      fastify.log.warn(error, `Failed to update lab order ${id} in CouchDB`)
    }

    return {
      postgres: {
        success: true,
        id,
      },
      couch: {
        success: !!couchResult,
        id: couchResult?.id,
        rev: couchResult?.rev,
      },
      overall: true,
    }
  }

  /**
   * Get lab order from PostgreSQL (primary source for queries)
   */
  async getLabOrder(id: string) {
    const fastify = this.dualWrite.fastify
    return fastify.prisma.labOrder.findUnique({
      where: { id },
      include: {
        specimens: true,
        results: true,
      },
    })
  }

  /**
   * List lab orders from PostgreSQL with pagination
   */
  async listLabOrders(params: {
    patientId?: string
    status?: string
    page?: number
    limit?: number
  }) {
    const fastify = this.dualWrite.fastify
    const page = params.page || 1
    const limit = params.limit || 20
    const skip = (page - 1) * limit

    const where: any = {}
    if (params.patientId) where.patientId = params.patientId
    if (params.status) where.status = params.status

    const [data, total] = await Promise.all([
      fastify.prisma.labOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { orderedAt: 'desc' },
        include: {
          specimens: true,
          results: true,
        },
      }),
      fastify.prisma.labOrder.count({ where }),
    ])

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }
  }
}

/**
 * Initialize dual-write services
 */
export function initializeDualWriteServices(fastify: FastifyInstance) {
  return {
    labOrders: new LabOrderDualWriteService(fastify),
    // Add more services as needed:
    // specimens: new SpecimenDualWriteService(fastify),
    // results: new LabResultDualWriteService(fastify),
  }
}

