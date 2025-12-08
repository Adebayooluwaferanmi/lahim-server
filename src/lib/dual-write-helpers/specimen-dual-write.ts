/**
 * Specimen specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Lab Specimens
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaSpecimen, CouchSpecimen } from '../mappers/specimen-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class SpecimenDualWriteHelper extends DualWriteHelper {
  /**
   * Write specimen to both databases
   */
  async writeSpecimen(
    couchDoc: CouchSpecimen,
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
    const prismaData = mapCouchToPrismaSpecimen(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.labSpecimen.upsert({
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
          this.fastify.log.error(error, `PostgreSQL specimen write failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB specimen write failed after ${retries} retries`)
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
      metrics.recordOperation('specimen', result)
    } catch (error) {
      // Silently fail metrics recording
    }
    
    return result
  }

  /**
   * Update specimen in both databases
   */
  async updateSpecimen(
    id: string,
    updates: Partial<CouchSpecimen>,
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
    let couchDoc: CouchSpecimen
    try {
      couchDoc = await this.couch.get(id) as CouchSpecimen
    } catch (error) {
      result.couch.error = error as Error
      result.postgres.error = new Error('CouchDB document not found')
      return result
    }

    // Merge updates
    const updatedCouchDoc = { ...couchDoc, ...updates, _id: id }
    const prismaData = mapCouchToPrismaSpecimen(updatedCouchDoc)

    // Update PostgreSQL
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.labSpecimen.update({
          where: { id },
          data: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL specimen update failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB specimen update failed after ${retries} retries`)
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
      metrics.recordOperation('specimen', result)
    } catch (error) {
      // Silently fail metrics recording
    }
    
    return result
  }
}

/**
 * Create a specimen dual-write helper
 */
export function createSpecimenDualWriteHelper(
  fastify: FastifyInstance,
  couchDatabase: string = 'specimens'
): SpecimenDualWriteHelper {
  const couch = fastify.couch.use(couchDatabase)
  return new SpecimenDualWriteHelper(fastify, couch, fastify.prisma)
}

