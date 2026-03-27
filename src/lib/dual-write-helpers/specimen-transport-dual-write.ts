/**
 * Specimen Transport Dual-Write Helper
 * Handles dual-write to both CouchDB and PostgreSQL for Specimen Transport
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import {
  mapCouchToPrismaSpecimenTransport,
  CouchSpecimenTransport,
} from '../mappers/specimen-transport-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class SpecimenTransportDualWriteHelper extends DualWriteHelper {
  constructor(fastify: FastifyInstance, couch: any, prisma: any) {
    super(fastify, couch, prisma)
  }

  async writeSpecimenTransport(
    couchDoc: CouchSpecimenTransport,
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

    const prismaData = mapCouchToPrismaSpecimenTransport(couchDoc)

    // Write to PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.specimenTransport.upsert({
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
          this.fastify.log.error(error, `PostgreSQL specimen transport write failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    // Write to CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const insertResult = await this.couch.insert(couchDoc)
        result.couch.success = true
        result.couch.id = insertResult.id
        result.couch.rev = insertResult.rev
        break
      } catch (error: any) {
        if (error.statusCode === 409) {
          result.couch.success = true
          break
        }
        if (attempt === retries) {
          result.couch.error = error
          this.fastify.log.error(error, `CouchDB specimen transport write failed after ${retries} retries`)
          if (failOnCouchDB) {
            return result
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    result.overall = result.postgres.success && result.couch.success

    // Record metrics
    const metrics = createDualWriteMetricsCollector(this.fastify)
    metrics.recordOperation('specimen-transport', result)

    return result
  }

  async updateSpecimenTransport(
    id: string,
    updates: Partial<CouchSpecimenTransport>,
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
    let existingCouchDoc: CouchSpecimenTransport | undefined
    try {
      existingCouchDoc = await this.couch.get(id) as CouchSpecimenTransport
    } catch (error: any) {
      if (error.statusCode !== 404) {
        this.fastify.log.warn(error, `Failed to fetch existing CouchDB specimen transport ${id} for update`)
      }
    }

    const updatedCouchDoc = {
      ...existingCouchDoc,
      ...updates,
      _id: id,
      type: 'specimen_transport',
    } as CouchSpecimenTransport
    if (existingCouchDoc?._rev) {
      updatedCouchDoc._rev = existingCouchDoc._rev
    }

    const prismaData = mapCouchToPrismaSpecimenTransport(updatedCouchDoc)

    // Update PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.specimenTransport.update({
          where: { id },
          data: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL specimen transport update failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    // Update CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const couchUpdateResult = await this.couch.insert(updatedCouchDoc)
        result.couch.success = true
        result.couch.id = couchUpdateResult.id
        result.couch.rev = couchUpdateResult.rev
        break
      } catch (error: any) {
        if (error.statusCode === 409 && attempt < retries) {
          this.fastify.log.debug(`CouchDB specimen transport update conflict for ${id}, retrying...`)
          existingCouchDoc = await this.couch.get(id) as CouchSpecimenTransport
          updatedCouchDoc._rev = existingCouchDoc._rev
          await this.delay(retryDelay * Math.pow(2, attempt))
          continue
        }
        if (attempt === retries) {
          result.couch.error = error
          this.fastify.log.error(error, `CouchDB specimen transport update failed after ${retries} retries`)
          if (failOnCouchDB) {
            return result
          }
        }
        await this.delay(retryDelay * Math.pow(2, attempt))
      }
    }

    result.overall = result.postgres.success && result.couch.success

    // Record metrics
    const metrics = createDualWriteMetricsCollector(this.fastify)
    metrics.recordOperation('specimen-transport', result)

    return result
  }
}

export function createSpecimenTransportDualWriteHelper(
  fastify: FastifyInstance
): SpecimenTransportDualWriteHelper {
  const db = fastify.couch?.db.use('specimen_transport')
  if (!db) {
    throw new Error('CouchDB specimen_transport database not available')
  }
  return new SpecimenTransportDualWriteHelper(fastify, db, fastify.prisma)
}

