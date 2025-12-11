/**
 * Practitioner specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Practitioners
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaPractitioner, CouchPractitioner } from '../mappers/practitioner-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class PractitionerDualWriteHelper extends DualWriteHelper {
  /**
   * Write practitioner to both databases
   */
  async writePractitioner(
    couchDoc: CouchPractitioner,
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
    const prismaData = mapCouchToPrismaPractitioner(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.practitioner.upsert({
          where: { practitionerId: prismaData.practitionerId },
          create: prismaData,
          update: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL practitioner write failed after ${retries} retries`)
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
        const insertResult = await this.couch.insert(couchDoc)
        result.couch.success = true
        result.couch.id = insertResult.id
        result.couch.rev = insertResult.rev
        break
      } catch (error) {
        if (attempt === retries) {
          result.couch.error = error as Error
          this.fastify.log.warn(error, `CouchDB practitioner write failed after ${retries} retries`)
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
    metrics.recordOperation('practitioner', result)

    return result
  }

  /**
   * Update practitioner in both databases
   */
  async updatePractitioner(
    practitionerId: string,
    updates: Partial<CouchPractitioner>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Get existing document from CouchDB
    let existing: CouchPractitioner
    try {
      const findResult = await this.couch.find({
        selector: {
          $or: [
            { practitionerId },
            { id: practitionerId },
          ],
        },
        limit: 1,
      })
      
      if (findResult.docs.length > 0) {
        existing = findResult.docs[0] as CouchPractitioner
      } else {
        throw new Error(`Practitioner with ID ${practitionerId} not found`)
      }
    } catch (error) {
      return {
        couch: { success: false, error: error as Error },
        postgres: { success: false, error: error as Error },
        overall: false,
      }
    }

    // Merge updates
    const updated = { ...existing, ...updates, _id: existing._id }

    // Use writePractitioner to handle both databases
    return this.writePractitioner(updated, options)
  }
}

/**
 * Factory function to create PractitionerDualWriteHelper
 */
export function createPractitionerDualWriteHelper(fastify: FastifyInstance): PractitionerDualWriteHelper {
  const db = fastify.couch?.db.use('practitioners') || fastify.couch?.db.use('users') // May be in users DB
  if (!db) {
    throw new Error('CouchDB practitioners/users database not available')
  }
  return new PractitionerDualWriteHelper(fastify, db, fastify.prisma)
}

