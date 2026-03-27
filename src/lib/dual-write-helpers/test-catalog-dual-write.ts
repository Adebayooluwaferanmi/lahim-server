/**
 * TestCatalog specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Test Catalog entries
 */

import { FastifyInstance } from 'fastify'
import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaTestCatalog, CouchTestCatalog } from '../mappers/test-catalog-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class TestCatalogDualWriteHelper extends DualWriteHelper {
  /**
   * Write test catalog entry to both databases
   */
  async writeTestCatalog(
    couchDoc: CouchTestCatalog,
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
    const prismaData = mapCouchToPrismaTestCatalog(couchDoc)

    // Write to PostgreSQL (primary)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.testCatalog.upsert({
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
          this.fastify.log.error(error, `PostgreSQL test catalog write failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB test catalog write failed after ${retries} retries`)
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
    metrics.recordOperation('test-catalog', result)

    return result
  }

  /**
   * Update test catalog entry in both databases
   */
  async updateTestCatalog(
    id: string,
    updates: Partial<CouchTestCatalog>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Get existing document from CouchDB
    let existing: CouchTestCatalog
    try {
      existing = await this.couch.get(id) as CouchTestCatalog
    } catch (error) {
      return {
        couch: { success: false, error: error as Error },
        postgres: { success: false, error: error as Error },
        overall: false,
      }
    }

    // Merge updates
    const updated = { ...existing, ...updates, _id: id }

    // Use writeTestCatalog to handle both databases
    return this.writeTestCatalog(updated, options)
  }

  /**
   * Delete test catalog entry from both databases (soft delete by setting active=false)
   */
  async deleteTestCatalog(
    id: string,
    _rev: string, // Unused but kept for API consistency
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Soft delete: set active=false instead of actually deleting
    const updates: Partial<CouchTestCatalog> = { active: false }
    return this.updateTestCatalog(id, updates, options)
  }
}

/**
 * Factory function to create TestCatalogDualWriteHelper
 */
export function createTestCatalogDualWriteHelper(fastify: FastifyInstance): TestCatalogDualWriteHelper {
  const db = fastify.couch?.db.use('test_catalog')
  if (!db) {
    throw new Error('CouchDB test_catalog database not available')
  }
  return new TestCatalogDualWriteHelper(fastify, db, fastify.prisma)
}

