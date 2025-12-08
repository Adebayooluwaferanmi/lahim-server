/**
 * Cache Metrics Monitoring
 * Tracks cache hit rates and performance
 */

import { FastifyInstance } from 'fastify'
import { CacheHelper } from '../db-utils'

export interface CacheMetrics {
  hits: number
  misses: number
  hitRate: number
  totalRequests: number
}

export class CacheMetricsCollector {
  private metrics: Map<string, CacheMetrics> = new Map()

  constructor(_fastify: FastifyInstance) {
    // Fastify instance stored for potential future use
  }

  /**
   * Record a cache hit
   */
  recordHit(endpoint: string) {
    const metric = this.getOrCreateMetric(endpoint)
    metric.hits++
    metric.totalRequests++
    metric.hitRate = (metric.hits / metric.totalRequests) * 100
  }

  /**
   * Record a cache miss
   */
  recordMiss(endpoint: string) {
    const metric = this.getOrCreateMetric(endpoint)
    metric.misses++
    metric.totalRequests++
    metric.hitRate = (metric.hits / metric.totalRequests) * 100
  }

  /**
   * Get metrics for an endpoint
   */
  getMetrics(endpoint: string): CacheMetrics | null {
    return this.metrics.get(endpoint) || null
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, CacheMetrics> {
    return this.metrics
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalEndpoints: number
    totalRequests: number
    totalHits: number
    totalMisses: number
    overallHitRate: number
    endpoints: Array<{ endpoint: string; metrics: CacheMetrics }>
  } {
    let totalRequests = 0
    let totalHits = 0
    let totalMisses = 0

    const endpoints: Array<{ endpoint: string; metrics: CacheMetrics }> = []

    for (const [endpoint, metric] of this.metrics.entries()) {
      totalRequests += metric.totalRequests
      totalHits += metric.hits
      totalMisses += metric.misses
      endpoints.push({ endpoint, metrics: metric })
    }

    const overallHitRate = totalRequests > 0 ? (totalHits / totalRequests) * 100 : 0

    return {
      totalEndpoints: this.metrics.size,
      totalRequests,
      totalHits,
      totalMisses,
      overallHitRate,
      endpoints: endpoints.sort((a, b) => b.metrics.totalRequests - a.metrics.totalRequests),
    }
  }

  /**
   * Reset metrics
   */
  reset(endpoint?: string) {
    if (endpoint) {
      this.metrics.delete(endpoint)
    } else {
      this.metrics.clear()
    }
  }

  /**
   * Get or create metric for endpoint
   */
  private getOrCreateMetric(endpoint: string): CacheMetrics {
    if (!this.metrics.has(endpoint)) {
      this.metrics.set(endpoint, {
        hits: 0,
        misses: 0,
        hitRate: 0,
        totalRequests: 0,
      })
    }
    return this.metrics.get(endpoint)!
  }
}

/**
 * Enhanced CacheHelper with metrics
 */
export class MetricsCacheHelper extends CacheHelper {
  private metrics: CacheMetricsCollector
  private endpoint: string

  constructor(redis: any, metrics: CacheMetricsCollector, endpoint: string) {
    super(redis)
    this.metrics = metrics
    this.endpoint = endpoint
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await super.get<T>(key)
    if (value !== null) {
      this.metrics.recordHit(this.endpoint)
    } else {
      this.metrics.recordMiss(this.endpoint)
    }
    return value
  }
}

/**
 * Create a metrics-enabled cache helper
 */
export function createMetricsCacheHelper(
  fastify: FastifyInstance,
  endpoint: string
): MetricsCacheHelper {
  const metrics = (fastify as any).cacheMetrics || new CacheMetricsCollector(fastify)
  if (!(fastify as any).cacheMetrics) {
    (fastify as any).cacheMetrics = metrics
  }
  return new MetricsCacheHelper(fastify.redis, metrics, endpoint)
}

