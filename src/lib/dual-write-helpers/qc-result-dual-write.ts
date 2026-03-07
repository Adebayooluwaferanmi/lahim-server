/**
 * QC Result specific dual-write helper
 * Handles mapping between CouchDB and Prisma for QC Results
 */

import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaQCResult, CouchQCResult } from '../mappers/qc-result-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class QCResultDualWriteHelper extends DualWriteHelper {
  /**
   * Write QC result to both databases
   */
  async writeQCResult(
    couchDoc: CouchQCResult,
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
    const prismaData = mapCouchToPrismaQCResult(couchDoc)

    // Validate required fields
    if (!prismaData.testCodeLoinc || !prismaData.qcMaterialLot) {
      result.postgres.error = new Error('testCodeLoinc and qcMaterialLot are required')
      return result
    }

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.qcResult.upsert({
          where: { id: prismaData.id },
          create: {
            ...prismaData,
            instrumentId: prismaData.instrumentId || null,
            performerId: prismaData.performerId || null,
            targetValue: prismaData.targetValue ?? null,
            acceptableRangeLow: prismaData.acceptableRangeLow ?? null,
            acceptableRangeHigh: prismaData.acceptableRangeHigh ?? null,
            unitUcum: prismaData.unitUcum || null,
          },
          update: {
            ...prismaData,
            instrumentId: prismaData.instrumentId || null,
            performerId: prismaData.performerId || null,
            targetValue: prismaData.targetValue ?? null,
            acceptableRangeLow: prismaData.acceptableRangeLow ?? null,
            acceptableRangeHigh: prismaData.acceptableRangeHigh ?? null,
            unitUcum: prismaData.unitUcum || null,
          },
        })
        result.postgres.success = true
        result.postgres.id = prismaData.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL QC result write failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB QC result write failed after ${retries} retries`)
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
      metrics.recordOperation('qc_result', result)
    } catch (error) {
      // Don't fail if metrics recording fails
      this.fastify.log.warn({ error }, 'Failed to record dual-write metrics')
    }

    return result
  }
}

