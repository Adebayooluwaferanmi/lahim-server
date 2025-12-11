/**
 * Lab Order specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Lab Orders
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaLabOrder, CouchLabOrder } from '../mappers/lab-order-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class LabOrderDualWriteHelper extends DualWriteHelper {
  /**
   * Write lab order to both databases
   */
  async writeLabOrder(
    couchDoc: CouchLabOrder,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    const {
      retries = 3,
      retryDelay = 1000,
      failOnCouchDB = false,
      failOnPostgres = true,
    } = options

    const result: DualWriteResult = {
      couch: { success: false },
      postgres: { success: false },
      overall: false,
    }

    // Map to Prisma format
    const prismaData = mapCouchToPrismaLabOrder(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.labOrder.upsert({
          where: { id: prismaData.id },
          create: {
            ...prismaData,
            // Handle nullable testCodeLoinc for panel orders
            testCodeLoinc: prismaData.testCodeLoinc || null,
            panelId: prismaData.panelId || null,
            isPanel: prismaData.isPanel || false,
          },
          update: {
            ...prismaData,
            testCodeLoinc: prismaData.testCodeLoinc || null,
            panelId: prismaData.panelId || null,
            isPanel: prismaData.isPanel || false,
          },
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL lab order write failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    // Write to CouchDB (secondary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.couch.insert(couchDoc)
        result.couch.success = true
        result.couch.id = response.id
        result.couch.rev = response.rev
        break
      } catch (error) {
        if (attempt === retries) {
          result.couch.error = error as Error
          this.fastify.log.warn(error, `CouchDB lab order write failed after ${retries} retries`)
          if (failOnCouchDB) {
            result.overall = false
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    result.overall = result.postgres.success && (!failOnCouchDB || result.couch.success)
    
    // Record metrics
    try {
      const metrics = createDualWriteMetricsCollector(this.fastify)
      metrics.recordOperation('lab-order', result)
    } catch (error) {
      // Silently fail metrics recording
    }
    
    return result
  }

  /**
   * Update lab order in both databases
   */
  async updateLabOrder(
    id: string,
    updates: Partial<CouchLabOrder>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    const {
      retries = 3,
      retryDelay = 1000,
      failOnCouchDB = false,
      failOnPostgres = true,
    } = options

    const result: DualWriteResult = {
      couch: { success: false },
      postgres: { success: false },
      overall: false,
    }

    // Get existing CouchDB document
    let couchDoc: CouchLabOrder
    try {
      couchDoc = await this.couch.get(id) as CouchLabOrder
    } catch (error) {
      result.couch.error = error as Error
      result.postgres.error = new Error('CouchDB document not found')
      return result
    }

    // Merge updates
    const updatedCouchDoc = { ...couchDoc, ...updates, _id: id }
    const prismaData = mapCouchToPrismaLabOrder(updatedCouchDoc)

    // Update PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.labOrder.update({
          where: { id },
          data: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL lab order update failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    // Update CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.couch.insert(updatedCouchDoc)
        result.couch.success = true
        result.couch.id = response.id
        result.couch.rev = response.rev
        break
      } catch (error) {
        if (attempt === retries) {
          result.couch.error = error as Error
          this.fastify.log.warn(error, `CouchDB lab order update failed after ${retries} retries`)
          if (failOnCouchDB) {
            result.overall = false
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    result.overall = result.postgres.success && (!failOnCouchDB || result.couch.success)
    
    // Record metrics
    try {
      const metrics = createDualWriteMetricsCollector(this.fastify)
      metrics.recordOperation('lab-order', result)
    } catch (error) {
      // Silently fail metrics recording
    }
    
    return result
  }
}

/**
 * Create a lab order dual-write helper
 */
export function createLabOrderDualWriteHelper(
  fastify: FastifyInstance,
  couchDatabase: string = 'lab_orders'
): LabOrderDualWriteHelper {
  const couch = fastify.couch.use(couchDatabase)
  return new LabOrderDualWriteHelper(fastify, couch, fastify.prisma)
}

