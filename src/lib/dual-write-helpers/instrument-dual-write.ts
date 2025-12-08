/**
 * Instrument specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Instruments
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaInstrument, CouchInstrument } from '../mappers/instrument-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class InstrumentDualWriteHelper extends DualWriteHelper {
  /**
   * Write instrument to both databases
   */
  async writeInstrument(
    couchDoc: CouchInstrument,
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
    const prismaData = mapCouchToPrismaInstrument(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.instrument.upsert({
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
          this.fastify.log.error(error, `PostgreSQL instrument write failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    // Write to CouchDB (secondary, for offline sync)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const insertResult = await this.couchDb.insert(couchDoc)
        result.couch.success = true
        result.couch.id = insertResult.id
        result.couch.rev = insertResult.rev
        break
      } catch (error) {
        if (attempt === retries) {
          result.couch.error = error as Error
          this.fastify.log.warn(error, `CouchDB instrument write failed after ${retries} retries`)
          if (failOnCouchDB) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    result.overall = result.postgres.success && (result.couch.success || !failOnCouchDB)

    // Record metrics
    const metrics = createDualWriteMetricsCollector(this.fastify)
    if (result.overall) {
      metrics.recordSuccess('instrument', 'write')
    } else {
      metrics.recordFailure('instrument', 'write')
    }

    return result
  }

  /**
   * Update instrument in both databases
   */
  async updateInstrument(
    id: string,
    updates: Partial<CouchInstrument>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Get existing document from CouchDB
    let existing: CouchInstrument
    try {
      existing = await this.couchDb.get(id) as CouchInstrument
    } catch (error) {
      return {
        couch: { success: false, error: error as Error },
        postgres: { success: false, error: error as Error },
        overall: false,
      }
    }

    // Merge updates
    const updated = { ...existing, ...updates, _id: id }

    // Use writeInstrument to handle both databases
    return this.writeInstrument(updated, options)
  }

  /**
   * Delete instrument from both databases
   */
  async deleteInstrument(
    id: string,
    rev: string,
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

    // Delete from PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.instrument.delete({ where: { id } })
        result.postgres.success = true
        result.postgres.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL instrument delete failed after ${retries} retries`)
          if (failOnPostgres) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    // Delete from CouchDB
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.couchDb.destroy(id, rev)
        result.couch.success = true
        result.couch.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.couch.error = error as Error
          this.fastify.log.warn(error, `CouchDB instrument delete failed after ${retries} retries`)
          if (failOnCouchDB) {
            return result
          }
        } else {
          await this.delay(retryDelay * (attempt + 1))
        }
      }
    }

    result.overall = result.postgres.success && (result.couch.success || !failOnCouchDB)

    // Record metrics
    const metrics = createDualWriteMetricsCollector(this.fastify)
    if (result.overall) {
      metrics.recordSuccess('instrument', 'delete')
    } else {
      metrics.recordFailure('instrument', 'delete')
    }

    return result
  }
}

/**
 * Factory function to create InstrumentDualWriteHelper
 */
export function createInstrumentDualWriteHelper(fastify: FastifyInstance): InstrumentDualWriteHelper {
  const db = fastify.couch?.db.use('instruments')
  if (!db) {
    throw new Error('CouchDB instruments database not available')
  }
  return new InstrumentDualWriteHelper(fastify, fastify.prisma, db)
}

