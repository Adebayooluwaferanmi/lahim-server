/**
 * Modern Lab Orders Service Example
 * 
 * This demonstrates how to use the new infrastructure:
 * - Dual-write pattern (PostgreSQL + CouchDB)
 * - Event bus for event-driven architecture
 * - Observability (metrics and tracing)
 * - Socket.io for real-time updates
 * 
 * This is an example implementation - integrate these patterns into existing services
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { withSpan, addSpanAttributes } from '../lib/tracing'
import { publishLabOrderEvent } from '../lib/event-bus'
import { 
  recordDatabaseQuery, 
  recordCacheHit, 
  recordCacheMiss 
} from '../plugins/observability'
import { CacheHelper } from '../lib/db-utils'
import { emitRealtimeEvent } from '../plugins/socketio'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const cache = new CacheHelper(fastify.redis)

  // GET /lab-orders - List lab orders (from PostgreSQL with caching)
  fastify.get('/lab-orders', async (request) => {
    return withSpan('list-lab-orders', async (span) => {
      const { limit = 50, skip = 0, status, patientId } = request.query as any

      // Add span attributes
      addSpanAttributes({
        'query.limit': limit,
        'query.skip': skip,
        'query.status': status || 'all',
      })

      // Try cache first
      const cacheKey = `lab-orders:${JSON.stringify({ limit, skip, status, patientId })}`
      const cached = await cache.get(cacheKey)
      
      if (cached) {
        recordCacheHit(fastify, 'redis')
        span.setAttribute('cache.hit', true)
        return cached
      }

      recordCacheMiss(fastify, 'redis')
      span.setAttribute('cache.hit', false)

      // Query PostgreSQL (primary database)
      const startTime = Date.now()
      const where: any = {}
      if (status) where.status = status
      if (patientId) where.patientId = patientId

      const [orders, total] = await Promise.all([
        fastify.prisma.labOrder.findMany({
          where,
          take: parseInt(limit, 10),
          skip: parseInt(skip, 10),
          orderBy: { orderedAt: 'desc' },
          include: {
            specimens: true,
            results: true,
          },
        }),
        fastify.prisma.labOrder.count({ where }),
      ])

      const queryDuration = (Date.now() - startTime) / 1000
      recordDatabaseQuery(fastify, 'findMany', 'LabOrder', queryDuration)

      const result = {
        orders,
        count: orders.length,
        total,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
      }

      // Cache for 1 minute
      await cache.set(cacheKey, result, 60)

      // Add span attributes
      addSpanAttributes({
        'result.count': orders.length,
        'result.total': total,
        'db.query.duration': queryDuration,
      })

      return result
    })
  })

  // GET /lab-orders/:id - Get single lab order
  fastify.get('/lab-orders/:id', async (request, reply) => {
    return withSpan('get-lab-order', async () => {
      const { id } = request.params as { id: string }

      addSpanAttributes({ 'order.id': id })

      // Try cache first
      const cacheKey = `lab-order:${id}`
      const cached = await cache.get(cacheKey)

      if (cached) {
        recordCacheHit(fastify, 'redis')
        return cached
      }

      recordCacheMiss(fastify, 'redis')

      // Query PostgreSQL
      const startTime = Date.now()
      const order = await fastify.prisma.labOrder.findUnique({
        where: { id },
        include: {
          specimens: true,
          results: {
            include: {
              microOrganisms: {
                include: {
                  susceptibilities: true,
                },
              },
            },
          },
        },
      })

      const queryDuration = (Date.now() - startTime) / 1000
      recordDatabaseQuery(fastify, 'findUnique', 'LabOrder', queryDuration)

      if (!order) {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, order, 300)

      return order
    })
  })

  // POST /lab-orders - Create lab order (dual-write + event)
  fastify.post('/lab-orders', async (request, reply) => {
    return withSpan('create-lab-order', async () => {
      const data = request.body as any

      addSpanAttributes({
        'order.patientId': data.patientId,
        'order.testCode': data.testCodeLoinc,
      })

      // Write to PostgreSQL (primary)
      const startTime = Date.now()
      const order = await fastify.prisma.labOrder.create({
        data: {
          patientId: data.patientId,
          testCodeLoinc: data.testCodeLoinc,
          status: data.status || 'requested',
          priority: data.priority,
          facilityId: data.facilityId,
          practitionerId: data.practitionerId,
        },
        include: {
          specimens: true,
          results: true,
        },
      })

      const queryDuration = (Date.now() - startTime) / 1000
      recordDatabaseQuery(fastify, 'create', 'LabOrder', queryDuration)

      // Write to CouchDB (for offline sync) - non-blocking
      const couchDb = fastify.couch.db.use('lab_orders')
      const couchData = {
        _id: order.id,
        type: 'lab_order',
        ...order,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
      }

      couchDb.insert(couchData).catch((error) => {
        fastify.log.warn(error, 'CouchDB write failed, but PostgreSQL write succeeded')
      })

      // Publish event
      await publishLabOrderEvent(fastify, 'created', order.id, order)

      // Emit real-time event via Socket.io
      emitRealtimeEvent(fastify, 'lab-orders', {
        type: 'create',
        id: order.id,
        data: order,
      })

      // Invalidate cache
      await cache.deletePattern('lab-orders:*')

      reply.code(201).send(order)
    })
  })

  // PUT /lab-orders/:id - Update lab order
  fastify.put('/lab-orders/:id', async (request) => {
    return withSpan('update-lab-order', async () => {
      const { id } = request.params as { id: string }
      const data = request.body as any

      addSpanAttributes({ 'order.id': id })

      // Update PostgreSQL
      const startTime = Date.now()
      const order = await fastify.prisma.labOrder.update({
        where: { id },
        data: {
          status: data.status,
          priority: data.priority,
          collectedAt: data.collectedAt ? new Date(data.collectedAt) : undefined,
          receivedAt: data.receivedAt ? new Date(data.receivedAt) : undefined,
          finalizedAt: data.finalizedAt ? new Date(data.finalizedAt) : undefined,
          updatedAt: new Date(),
        },
        include: {
          specimens: true,
          results: true,
        },
      })

      const queryDuration = (Date.now() - startTime) / 1000
      recordDatabaseQuery(fastify, 'update', 'LabOrder', queryDuration)

      // Update CouchDB - non-blocking
      const couchDb = fastify.couch.db.use('lab_orders')
      couchDb.get(id)
        .then((doc) => {
          const updated = {
            ...doc,
            ...order,
            updatedAt: order.updatedAt.toISOString(),
            _rev: doc._rev,
          }
          return couchDb.insert(updated)
        })
        .catch((error) => {
          fastify.log.warn(error, 'CouchDB update failed')
        })

      // Publish event
      await publishLabOrderEvent(fastify, 'updated', order.id, order)

      // Emit real-time event
      emitRealtimeEvent(fastify, 'lab-orders', {
        type: 'update',
        id: order.id,
        data: order,
      })

      // Invalidate cache
      await cache.delete(`lab-order:${id}`)
      await cache.deletePattern('lab-orders:*')

      return order
    })
  })

  // DELETE /lab-orders/:id - Delete lab order (soft delete)
  fastify.delete('/lab-orders/:id', async (request) => {
    return withSpan('delete-lab-order', async () => {
      const { id } = request.params as { id: string }

      addSpanAttributes({ 'order.id': id })

      // Soft delete in PostgreSQL (mark as deleted)
      const startTime = Date.now()
      // Note: Add deletedAt field to schema for soft deletes
      // For now, we'll just delete
      await fastify.prisma.labOrder.delete({
        where: { id },
      })

      const queryDuration = (Date.now() - startTime) / 1000
      recordDatabaseQuery(fastify, 'delete', 'LabOrder', queryDuration)

      // Soft delete in CouchDB
      const couchDb = fastify.couch.db.use('lab_orders')
      couchDb.get(id)
        .then((doc) => {
          // Remove document from CouchDB (CouchDB handles deletion differently)
          return couchDb.destroy(id, doc._rev)
        })
        .catch((error) => {
          fastify.log.warn(error, 'CouchDB delete failed')
        })

      // Publish event (using 'updated' since 'deleted' is not in the type)
      await publishLabOrderEvent(fastify, 'updated', id, { id, deleted: true })

      // Emit real-time event
      emitRealtimeEvent(fastify, 'lab-orders', {
        type: 'delete',
        id,
      })

      // Invalidate cache
      await cache.delete(`lab-order:${id}`)
      await cache.deletePattern('lab-orders:*')
    })
  })

  next()
}

