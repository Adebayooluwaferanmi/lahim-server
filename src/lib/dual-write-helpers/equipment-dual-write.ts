/**
 * Equipment Dual-Write Helper
 * Handles dual-write to both CouchDB and PostgreSQL for Equipment
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import {
  mapCouchToPrismaEquipment,
  mapCouchToPrismaEquipmentMaintenance,
  CouchEquipment,
  CouchEquipmentMaintenance,
} from '../mappers/equipment-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class EquipmentDualWriteHelper extends DualWriteHelper {
  constructor(fastify: FastifyInstance) {
    super(fastify, 'equipment', createDualWriteMetricsCollector(fastify, 'equipment'))
  }

  async writeEquipment(
    couchDoc: CouchEquipment,
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

    const prismaData = mapCouchToPrismaEquipment(couchDoc)

    // Write to PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.equipment.upsert({
          where: { id: prismaData.id },
          create: prismaData,
          update: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL equipment write failed after ${retries} retries`)
          if (failOnPostgres) {
            this.metrics.recordFailure('postgres')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    // Write to CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.couch.db.use('equipment').insert(couchDoc)
        result.couch.success = true
        result.couch.id = couchDoc._id
        result.couch.rev = couchDoc._rev
        break
      } catch (error: any) {
        if (error.statusCode === 409) {
          result.couch.success = true
          break
        }
        if (attempt === retries) {
          result.couch.error = error
          this.fastify.log.error(error, `CouchDB equipment write failed after ${retries} retries`)
          if (failOnCouchDB) {
            this.metrics.recordFailure('couchdb')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    result.overall = result.postgres.success && result.couch.success
    if (result.overall) {
      this.metrics.recordSuccess()
    } else {
      this.metrics.recordFailure('overall')
    }

    return result
  }

  async updateEquipment(
    id: string,
    updates: Partial<CouchEquipment>,
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

    // Fetch existing CouchDB document
    let existingCouchDoc: CouchEquipment | undefined
    try {
      existingCouchDoc = await this.couch.db.use('equipment').get(id) as CouchEquipment
    } catch (error: any) {
      if (error.statusCode !== 404) {
        this.fastify.log.warn(error, `Failed to fetch existing CouchDB equipment ${id} for update`)
      }
    }

    const updatedCouchDoc = {
      ...existingCouchDoc,
      ...updates,
      _id: id,
      type: 'equipment',
    } as CouchEquipment
    if (existingCouchDoc?._rev) {
      updatedCouchDoc._rev = existingCouchDoc._rev
    }

    const prismaData = mapCouchToPrismaEquipment(updatedCouchDoc)

    // Update PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.equipment.update({
          where: { id },
          data: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL equipment update failed after ${retries} retries`)
          if (failOnPostgres) {
            this.metrics.recordFailure('postgres')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    // Update CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const couchUpdateResult = await this.couch.db.use('equipment').insert(updatedCouchDoc)
        result.couch.success = true
        result.couch.id = couchUpdateResult.id
        result.couch.rev = couchUpdateResult.rev
        break
      } catch (error: any) {
        if (error.statusCode === 409 && attempt < retries) {
          this.fastify.log.debug(`CouchDB equipment update conflict for ${id}, retrying...`)
          existingCouchDoc = await this.couch.db.use('equipment').get(id) as CouchEquipment
          updatedCouchDoc._rev = existingCouchDoc._rev
          await this.delay(retryDelay * Math.pow(2, attempt))
          continue
        }
        if (attempt === retries) {
          result.couch.error = error
          this.fastify.log.error(error, `CouchDB equipment update failed after ${retries} retries`)
          if (failOnCouchDB) {
            this.metrics.recordFailure('couchdb')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    result.overall = result.postgres.success && result.couch.success
    if (result.overall) {
      this.metrics.recordSuccess()
    } else {
      this.metrics.recordFailure('overall')
    }

    return result
  }

  async writeMaintenance(
    couchDoc: CouchEquipmentMaintenance,
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

    const prismaData = mapCouchToPrismaEquipmentMaintenance(couchDoc)

    // Write to PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.equipmentMaintenance.upsert({
          where: { id: prismaData.id },
          create: prismaData,
          update: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL equipment maintenance write failed after ${retries} retries`)
          if (failOnPostgres) {
            this.metrics.recordFailure('postgres')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    // Write to CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.couch.db.use('equipment').insert(couchDoc)
        result.couch.success = true
        result.couch.id = couchDoc._id
        result.couch.rev = couchDoc._rev
        break
      } catch (error: any) {
        if (error.statusCode === 409) {
          result.couch.success = true
          break
        }
        if (attempt === retries) {
          result.couch.error = error
          this.fastify.log.error(error, `CouchDB equipment maintenance write failed after ${retries} retries`)
          if (failOnCouchDB) {
            this.metrics.recordFailure('couchdb')
            throw error
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    result.overall = result.postgres.success && result.couch.success
    if (result.overall) {
      this.metrics.recordSuccess()
    } else {
      this.metrics.recordFailure('overall')
    }

    return result
  }
}

export function createEquipmentDualWriteHelper(
  fastify: FastifyInstance
): EquipmentDualWriteHelper {
  return new EquipmentDualWriteHelper(fastify)
}

