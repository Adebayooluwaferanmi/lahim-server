/**
 * Metrics Service
 * Provides endpoints to view cache and dual-write metrics
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { CacheMetricsCollector } from '../lib/monitoring/cache-metrics'
import { DualWriteMetricsCollector } from '../lib/monitoring/dual-write-metrics'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  // GET /metrics/cache - Get cache metrics
  fastify.get('/metrics/cache', async (_request, reply) => {
    try {
      const cacheMetrics = (fastify as any).cacheMetrics as CacheMetricsCollector | undefined

      if (!cacheMetrics) {
        return reply.send({
          error: 'Cache metrics not available',
          message: 'Cache metrics collector not initialized',
        })
      }

      const summary = cacheMetrics.getSummary()

      reply.send({
        summary: {
          totalEndpoints: summary.totalEndpoints,
          totalRequests: summary.totalRequests,
          totalHits: summary.totalHits,
          totalMisses: summary.totalMisses,
          overallHitRate: Number(summary.overallHitRate.toFixed(2)),
        },
        endpoints: summary.endpoints.map((e) => ({
          endpoint: e.endpoint,
          hits: e.metrics.hits,
          misses: e.metrics.misses,
          totalRequests: e.metrics.totalRequests,
          hitRate: Number(e.metrics.hitRate.toFixed(2)),
        })),
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'Failed to get cache metrics')
      reply.code(500).send({ error: 'Failed to get cache metrics' })
    }
  })

  // GET /metrics/dual-write - Get dual-write metrics
  fastify.get('/metrics/dual-write', async (_request, reply) => {
    try {
      const dualWriteMetrics = (fastify as any).dualWriteMetrics as DualWriteMetricsCollector | undefined

      if (!dualWriteMetrics) {
        return reply.send({
          error: 'Dual-write metrics not available',
          message: 'Dual-write metrics collector not initialized',
        })
      }

      const summary = dualWriteMetrics.getSummary()

      reply.send({
        summary: {
          totalOperations: summary.totalOperations,
          totalSuccess: summary.totalSuccess,
          totalFailed: summary.totalFailed,
          overallSuccessRate: Number(summary.overallSuccessRate.toFixed(2)),
        },
        entities: summary.entities.map((e) => ({
          entityType: e.entityType,
          total: e.metrics.total,
          success: e.metrics.success,
          postgresOnly: e.metrics.postgresOnly,
          couchOnly: e.metrics.couchOnly,
          failed: e.metrics.failed,
          successRate: Number(e.metrics.successRate.toFixed(2)),
          averageRetries: Number(e.metrics.averageRetries.toFixed(2)),
        })),
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'Failed to get dual-write metrics')
      reply.code(500).send({ error: 'Failed to get dual-write metrics' })
    }
  })

  // GET /metrics/all - Get all metrics
  fastify.get('/metrics/all', async (_request, reply) => {
    try {
      const cacheMetrics = (fastify as any).cacheMetrics as CacheMetricsCollector | undefined
      const dualWriteMetrics = (fastify as any).dualWriteMetrics as DualWriteMetricsCollector | undefined

      const response: any = {}

      if (cacheMetrics) {
        const cacheSummary = cacheMetrics.getSummary()
        response.cache = {
          summary: {
            totalEndpoints: cacheSummary.totalEndpoints,
            totalRequests: cacheSummary.totalRequests,
            totalHits: cacheSummary.totalHits,
            totalMisses: cacheSummary.totalMisses,
            overallHitRate: Number(cacheSummary.overallHitRate.toFixed(2)),
          },
        }
      } else {
        response.cache = { error: 'Not available' }
      }

      if (dualWriteMetrics) {
        const dualWriteSummary = dualWriteMetrics.getSummary()
        response.dualWrite = {
          summary: {
            totalOperations: dualWriteSummary.totalOperations,
            totalSuccess: dualWriteSummary.totalSuccess,
            totalFailed: dualWriteSummary.totalFailed,
            overallSuccessRate: Number(dualWriteSummary.overallSuccessRate.toFixed(2)),
          },
        }
      } else {
        response.dualWrite = { error: 'Not available' }
      }

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'Failed to get metrics')
      reply.code(500).send({ error: 'Failed to get metrics' })
    }
  })

  // POST /metrics/reset - Reset metrics
  fastify.post('/metrics/reset', async (request, reply) => {
    try {
      const { type, endpoint } = request.body as { type?: string; endpoint?: string }

      if (type === 'cache' || !type) {
        const cacheMetrics = (fastify as any).cacheMetrics as CacheMetricsCollector | undefined
        if (cacheMetrics) {
          cacheMetrics.reset(endpoint)
        }
      }

      if (type === 'dual-write' || !type) {
        const dualWriteMetrics = (fastify as any).dualWriteMetrics as DualWriteMetricsCollector | undefined
        if (dualWriteMetrics) {
          dualWriteMetrics.reset(endpoint)
        }
      }

      reply.send({ message: 'Metrics reset successfully' })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'Failed to reset metrics')
      reply.code(500).send({ error: 'Failed to reset metrics' })
    }
  })

  next()
}

