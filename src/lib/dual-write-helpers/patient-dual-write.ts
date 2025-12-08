/**
 * Patient specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Patients
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaPatient, CouchPatient } from '../mappers/patient-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class PatientDualWriteHelper extends DualWriteHelper {
  /**
   * Write patient to both databases
   */
  async writePatient(
    couchDoc: CouchPatient,
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
    const prismaData = mapCouchToPrismaPatient(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.patient.upsert({
          where: { patientId: prismaData.patientId },
          create: prismaData,
          update: prismaData,
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL patient write failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB patient write failed after ${retries} retries`)
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
      metrics.recordSuccess('patient', 'write')
    } else {
      metrics.recordFailure('patient', 'write')
    }

    return result
  }

  /**
   * Update patient in both databases
   */
  async updatePatient(
    patientId: string,
    updates: Partial<CouchPatient>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Get existing document from CouchDB
    let existing: CouchPatient
    try {
      // Try to find by patientId first
      const findResult = await this.couchDb.find({
        selector: {
          $or: [
            { 'data.friendlyId': patientId },
            { 'data.externalPatientId': patientId },
            { friendlyId: patientId },
            { externalPatientId: patientId },
          ],
        },
        limit: 1,
      })
      
      if (findResult.docs.length > 0) {
        existing = findResult.docs[0] as CouchPatient
      } else {
        throw new Error(`Patient with ID ${patientId} not found`)
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

    // Use writePatient to handle both databases
    return this.writePatient(updated, options)
  }
}

/**
 * Factory function to create PatientDualWriteHelper
 */
export function createPatientDualWriteHelper(fastify: FastifyInstance): PatientDualWriteHelper {
  const db = fastify.couch?.db.use('patients')
  if (!db) {
    throw new Error('CouchDB patients database not available')
  }
  return new PatientDualWriteHelper(fastify, fastify.prisma, db)
}

