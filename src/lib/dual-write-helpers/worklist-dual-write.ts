/**
 * Worklist specific dual-write helper
 * Handles mapping between CouchDB and Prisma for Worklists and WorklistItems
 */

import { DualWriteHelper, DualWriteOptions, DualWriteResult } from '../dual-write'
import { mapCouchToPrismaWorklist, CouchWorklist } from '../mappers/worklist-mapper'
import { createDualWriteMetricsCollector } from '../monitoring/dual-write-metrics'

export class WorklistDualWriteHelper extends DualWriteHelper {
  /**
   * Write worklist to both databases
   * Handles nested WorklistItem creation
   */
  async writeWorklist(
    couchDoc: CouchWorklist,
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
    const { worklist: prismaWorklist, items: prismaItems } = mapCouchToPrismaWorklist(couchDoc)

    // Write to PostgreSQL (primary) - use transaction for worklist + items
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.prisma.$transaction(async (tx: any) => {
          // Upsert worklist
          await tx.worklist.upsert({
            where: { id: prismaWorklist.id },
            create: prismaWorklist,
            update: prismaWorklist,
          })

          // Delete existing items and create new ones
          await tx.worklistItem.deleteMany({
            where: { worklistId: prismaWorklist.id },
          })

          // Create new items
          if (prismaItems.length > 0) {
            await tx.worklistItem.createMany({
              data: prismaItems,
            })
          }
        })

        result.postgres.success = true
        result.postgres.id = prismaWorklist.id
        break
      } catch (error) {
        if (attempt === retries) {
          result.postgres.error = error as Error
          this.fastify.log.error(error, `PostgreSQL worklist write failed after ${retries} retries`)
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
          this.fastify.log.warn(error, `CouchDB worklist write failed after ${retries} retries`)
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
      metrics.recordOperation('worklist', result)
    } catch (error) {
      // Don't fail if metrics recording fails
      this.fastify.log.warn({ error }, 'Failed to record dual-write metrics')
    }

    return result
  }

  /**
   * Update worklist in both databases
   */
  async updateWorklist(
    id: string,
    updates: Partial<CouchWorklist>,
    options: DualWriteOptions = {}
  ): Promise<DualWriteResult> {
    // Get existing document from CouchDB
    let existing: CouchWorklist
    try {
      existing = await this.couch.get(id) as CouchWorklist
    } catch (error) {
      return {
        couch: { success: false, error: error as Error },
        postgres: { success: false, error: error as Error },
        overall: false,
      }
    }

    // Merge updates
    const updated = { ...existing, ...updates, _id: id }

    // Use writeWorklist to handle both databases
    return this.writeWorklist(updated, options)
  }
}

