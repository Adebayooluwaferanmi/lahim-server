/**
 * Observability Plugin for Fastify
 * Provides OpenTelemetry tracing and Prometheus metrics
 */

import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { Registry, Counter, Histogram, Gauge } from 'prom-client'

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      httpRequestDuration: Histogram<string>
      httpRequestTotal: Counter<string>
      httpRequestErrors: Counter<string>
      activeConnections: Gauge<string>
      databaseQueryDuration: Histogram<string>
      cacheHitRate: Counter<string>
      cacheMissRate: Counter<string>
    }
    metricsRegistry: Registry
  }
}

const observabilityPlugin: FastifyPluginAsync = async (fastify) => {
  // Create Prometheus registry
  const register = new Registry()

  // Default metrics (CPU, memory, etc.)
  register.setDefaultLabels({
    app: 'lahim-server',
    environment: process.env.NODE_ENV || 'development',
  })

  // HTTP Metrics
  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
  })

  const httpRequestTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
  })

  const httpRequestErrors = new Counter({
    name: 'http_request_errors_total',
    help: 'Total number of HTTP request errors',
    labelNames: ['method', 'route', 'error_type'],
    registers: [register],
  })

  // Connection Metrics
  const activeConnections = new Gauge({
    name: 'active_connections',
    help: 'Number of active connections',
    registers: [register],
  })

  // Database Metrics
  const databaseQueryDuration = new Histogram({
    name: 'database_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['operation', 'table'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  })

  // Cache Metrics
  const cacheHitRate = new Counter({
    name: 'cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['cache_type'],
    registers: [register],
  })

  const cacheMissRate = new Counter({
    name: 'cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['cache_type'],
    registers: [register],
  })

  // Add metrics to Fastify instance
  fastify.decorate('metrics', {
    httpRequestDuration,
    httpRequestTotal,
    httpRequestErrors,
    activeConnections,
    databaseQueryDuration,
    cacheHitRate,
    cacheMissRate,
  })

  fastify.decorate('metricsRegistry', register)

  // Request timing middleware
  fastify.addHook('onRequest', async (request) => {
    ;(request as any).startTime = Date.now()
    activeConnections.inc()
  })

  fastify.addHook('onResponse', async (request, reply) => {
    const duration = (Date.now() - ((request as any).startTime || Date.now())) / 1000
    const route = request.routerPath || request.url
    const method = request.method
    const statusCode = reply.statusCode

    // Record metrics
    httpRequestDuration.observe({ method, route, status_code: statusCode }, duration)
    httpRequestTotal.inc({ method, route, status_code: statusCode })

    // Record errors
    if (statusCode >= 400) {
      httpRequestErrors.inc({
        method,
        route,
        error_type: statusCode >= 500 ? 'server_error' : 'client_error',
      })
    }

    activeConnections.dec()
  })

  // Error tracking
  fastify.addHook('onError', async (request, _reply, error) => {
    const route = request.routerPath || request.url
    const method = request.method

    httpRequestErrors.inc({
      method,
      route,
      error_type: error.name || 'unknown_error',
    })

    fastify.log.error(
      {
        method,
        route,
        error: error.message,
        stack: error.stack,
      },
      'Request error'
    )
  })

  // Metrics endpoint
  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain')
    return register.metrics()
  })

  fastify.log.info('Observability plugin registered')
}

export default fp(observabilityPlugin, {
  name: 'observability',
  dependencies: [],
})

/**
 * Helper to record database query metrics
 */
export function recordDatabaseQuery(
  fastify: any,
  operation: string,
  table: string,
  duration: number
) {
  if (fastify.metrics) {
    fastify.metrics.databaseQueryDuration.observe({ operation, table }, duration)
  }
}

/**
 * Helper to record cache metrics
 */
export function recordCacheHit(fastify: any, cacheType: string = 'redis') {
  if (fastify.metrics) {
    fastify.metrics.cacheHitRate.inc({ cache_type: cacheType })
  }
}

export function recordCacheMiss(fastify: any, cacheType: string = 'redis') {
  if (fastify.metrics) {
    fastify.metrics.cacheMissRate.inc({ cache_type: cacheType })
  }
}

