import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { createLabOrderDualWriteHelper } from '../lib/dual-write-helpers/lab-order-dual-write'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('lab_orders')
  const cache = createMetricsCacheHelper(fastify, 'lab-orders')
  const dualWrite = fastify.prisma ? createLabOrderDualWriteHelper(fastify) : null

  // Create indexes on service load (fire and forget, but log errors)
  createCouchDBIndexes(
    fastify,
    'lab_orders',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'orderedOn'] }, name: 'type-orderedOn-index' },
      { index: { fields: ['type', 'status', 'orderedOn'] }, name: 'type-status-orderedOn-index' },
    ],
    'Lab Orders'
  ).catch((err) => {
    fastify.log.warn({ error: err }, 'Failed to create lab-orders indexes on startup')
  })

  // GET /lab-orders - List lab orders
  fastify.get('/lab-orders', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId } = request.query as any
      
      // Create cache key
      const cacheKey = `lab-orders:${status || 'all'}:${patientId || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lab_orders.list_cache_hit')
        return reply.send(cached)
      }

      const selector: any = { type: 'lab_order' }

      if (status) selector.status = status
      if (patientId) selector.patientId = patientId

      let result
      try {
        result = await db.find({
          selector,
          limit: parseInt(limit, 10),
          skip: parseInt(skip, 10),
          sort: [{ orderedOn: 'desc' }],
        })
      } catch (sortError: any) {
        // If sort fails due to missing index, try to create it and retry
        const errorMessage = sortError?.message || String(sortError)
        if (errorMessage.includes('No index exists for this sort')) {
          fastify.log.warn('Index missing for sort, creating index and retrying...')
          try {
            // Try to create the index
            await createCouchDBIndexes(
              fastify,
              'lab_orders',
              [
                { index: { fields: ['type', 'orderedOn'] }, name: 'type-orderedOn-index' },
                { index: { fields: ['type', 'status', 'orderedOn'] }, name: 'type-status-orderedOn-index' },
              ],
              'Lab Orders'
            )
            // Retry the query
            result = await db.find({
              selector,
              limit: parseInt(limit, 10),
              skip: parseInt(skip, 10),
              sort: [{ orderedOn: 'desc' }],
            })
          } catch (retryError) {
            // If retry still fails, try without sort
            fastify.log.warn('Retry with index failed, trying without sort...')
            result = await db.find({
              selector,
              limit: parseInt(limit, 10),
              skip: parseInt(skip, 10),
            })
            // Sort in memory as fallback
            if (result.docs && Array.isArray(result.docs)) {
              result.docs.sort((a: any, b: any) => {
                const aDate = a.orderedOn ? new Date(a.orderedOn).getTime() : 0
                const bDate = b.orderedOn ? new Date(b.orderedOn).getTime() : 0
                return bDate - aDate
              })
            }
          }
        } else {
          throw sortError
        }
      }

      const response = { orders: result.docs, count: result.docs.length }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: result.docs.length }, 'lab_orders.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_orders.list_failed')
      reply.code(500).send({ error: 'Failed to list lab orders' })
    }
  })

  // GET /lab-orders/:id - Get single lab order
  fastify.get('/lab-orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      fastify.log.debug({ id }, 'lab_orders.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_orders.get_failed')
      reply.code(500).send({ error: 'Failed to get lab order' })
    }
  })

  // POST /lab-orders - Create lab order
  fastify.post('/lab-orders', async (request, reply) => {
    try {
      const order = request.body as any

      if (!order.patientId || !order.tests || order.tests.length === 0) {
        reply.code(400).send({ error: 'Patient ID and at least one test are required' })
        return
      }

      const now = new Date().toISOString()
      const newOrder = {
        ...order,
        type: 'lab_order' as const,
        status: order.status || 'ordered',
        orderedOn: order.orderedOn || now,
        createdAt: now,
        updatedAt: now,
      }

      // Use dual-write if available, otherwise fallback to CouchDB only
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          // Generate ID if not provided
          if (!newOrder._id) {
            newOrder._id = `lab_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          }

          const dualWriteResult = await dualWrite.writeLabOrder(newOrder, {
            failOnCouchDB: false, // Don't fail if CouchDB fails
            failOnPostgres: true, // Fail if PostgreSQL fails
          })

          if (!dualWriteResult.overall) {
            fastify.log.error(
              { 
                postgres: dualWriteResult.postgres.error,
                couch: dualWriteResult.couch.error 
              },
              'Dual-write failed, falling back to CouchDB only'
            )
            // Fallback to CouchDB only
            const fallbackResult = await db.insert(newOrder)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || newOrder._id,
              rev: dualWriteResult.couch.rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write error, falling back to CouchDB only')
          const fallbackResult = await db.insert(newOrder)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(newOrder)
        result = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.deletePattern('lab-orders:*')

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'lab.order.created',
            result.id,
            'lab-order',
            newOrder,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab order created event')
      }

      fastify.log.info({ id: result.id, patientId: order.patientId }, 'lab_orders.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newOrder })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_orders.create_failed')
      reply.code(500).send({ error: 'Failed to create lab order' })
    }
  })

  // PUT /lab-orders/:id - Update lab order
  fastify.put('/lab-orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      // Use dual-write if available
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.updateLabOrder(id, updates, {
            failOnCouchDB: false,
            failOnPostgres: true,
          })

          if (!dualWriteResult.overall) {
            fastify.log.error(
              {
                postgres: dualWriteResult.postgres.error,
                couch: dualWriteResult.couch.error,
              },
              'Dual-write update failed, falling back to CouchDB only'
            )
            // Fallback to CouchDB only
            const fallbackResult = await db.insert(updated)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || id,
              rev: dualWriteResult.couch.rev || existing._rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write update error, falling back to CouchDB only')
          const fallbackResult = await db.insert(updated)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(updated)
        result = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.delete(`lab-order:${id}`)
      await cache.deletePattern('lab-orders:*')

      // Publish event - check if status changed to completed
      const eventType = updated.status === 'completed' ? 'lab.order.completed' : 'lab.order.updated'
      try {
        await eventBus.publish(
          eventBus.createEvent(
            eventType,
            id,
            'lab-order',
            updated,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, `Failed to publish ${eventType} event`)
      }

      fastify.log.info({ id }, 'lab_orders.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_orders.update_failed')
      reply.code(500).send({ error: 'Failed to update lab order' })
    }
  })

  next()
}

