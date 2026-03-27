/**
 * Dual-Write Metrics Monitoring
 * Tracks dual-write success rates and failures
 */

import { FastifyInstance } from 'fastify'
import { DualWriteResult } from '../dual-write'

export interface DualWriteMetrics {
  total: number
  success: number
  postgresOnly: number
  couchOnly: number
  failed: number
  successRate: number
  averageRetries: number
}

export class DualWriteMetricsCollector {
  private metrics: Map<string, DualWriteMetrics> = new Map()
  private retryCounts: Map<string, number[]> = new Map()

  constructor(_fastify: FastifyInstance) {
    // Fastify instance stored for potential future use
  }

  /**
   * Record a dual-write operation
   */
  recordOperation(
    entityType: string,
    result: DualWriteResult,
    retries?: number
  ) {
    const metric = this.getOrCreateMetric(entityType)
    metric.total++

    if (result.overall) {
      metric.success++
    } else if (result.postgres.success && !result.couch.success) {
      metric.postgresOnly++
    } else if (!result.postgres.success && result.couch.success) {
      metric.couchOnly++
    } else {
      metric.failed++
    }

    metric.successRate = (metric.success / metric.total) * 100

    if (retries !== undefined) {
      if (!this.retryCounts.has(entityType)) {
        this.retryCounts.set(entityType, [])
      }
      this.retryCounts.get(entityType)!.push(retries)
      const retriesList = this.retryCounts.get(entityType)!
      metric.averageRetries =
        retriesList.reduce((a, b) => a + b, 0) / retriesList.length
    }
  }

  /**
   * Get metrics for an entity type
   */
  getMetrics(entityType: string): DualWriteMetrics | null {
    return this.metrics.get(entityType) || null
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, DualWriteMetrics> {
    return this.metrics
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalOperations: number
    totalSuccess: number
    totalFailed: number
    overallSuccessRate: number
    entities: Array<{ entityType: string; metrics: DualWriteMetrics }>
  } {
    let totalOperations = 0
    let totalSuccess = 0
    let totalFailed = 0

    const entities: Array<{ entityType: string; metrics: DualWriteMetrics }> = []

    for (const [entityType, metric] of this.metrics.entries()) {
      totalOperations += metric.total
      totalSuccess += metric.success
      totalFailed += metric.failed
      entities.push({ entityType, metrics: metric })
    }

    const overallSuccessRate =
      totalOperations > 0 ? (totalSuccess / totalOperations) * 100 : 0

    return {
      totalOperations,
      totalSuccess,
      totalFailed,
      overallSuccessRate,
      entities: entities.sort((a, b) => b.metrics.total - a.metrics.total),
    }
  }

  /**
   * Reset metrics
   */
  reset(entityType?: string) {
    if (entityType) {
      this.metrics.delete(entityType)
      this.retryCounts.delete(entityType)
    } else {
      this.metrics.clear()
      this.retryCounts.clear()
    }
  }

  /**
   * Get or create metric for entity type
   */
  private getOrCreateMetric(entityType: string): DualWriteMetrics {
    if (!this.metrics.has(entityType)) {
      this.metrics.set(entityType, {
        total: 0,
        success: 0,
        postgresOnly: 0,
        couchOnly: 0,
        failed: 0,
        successRate: 0,
        averageRetries: 0,
      })
    }
    return this.metrics.get(entityType)!
  }
}

/**
 * Create a metrics collector instance
 */
export function createDualWriteMetricsCollector(
  fastify: FastifyInstance
): DualWriteMetricsCollector {
  if (!(fastify as any).dualWriteMetrics) {
    (fastify as any).dualWriteMetrics = new DualWriteMetricsCollector(fastify)
  }
  return (fastify as any).dualWriteMetrics
}

