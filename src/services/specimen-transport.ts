/**
 * Specimen Transport Service
 * Manages specimen transport tracking for internal and external labs
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'
import { createCouchDBIndexes } from '../lib/db-utils'
import { createSpecimenTransportDualWriteHelper } from '../lib/dual-write-helpers/specimen-transport-dual-write'
import { CouchSpecimenTransport } from '../lib/mappers/specimen-transport-mapper'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('specimen_transport')
    : null
  const cache = fastify.redis ? new CacheHelper(fastify.redis) : null
  const dualWrite = fastify.prisma ? createSpecimenTransportDualWriteHelper(fastify) : null

  // Create indexes on service load
  if (fastify.couchAvailable && fastify.couch) {
    createCouchDBIndexes(
      fastify,
      'specimen_transport',
      [
        { index: { fields: ['type'] }, name: 'type-index' },
        { index: { fields: ['type', 'specimenId'] }, name: 'type-specimenId-index' },
        { index: { fields: ['type', 'orderId'] }, name: 'type-orderId-index' },
        { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
        { index: { fields: ['type', 'transportType'] }, name: 'type-transportType-index' },
        { index: { fields: ['type', 'scheduledAt'] }, name: 'type-scheduledAt-index' },
        { index: { fields: ['type', 'status', 'scheduledAt'] }, name: 'type-status-scheduledAt-index' },
      ],
      'Specimen Transport'
    ).catch((err) => {
      fastify.log.warn({ error: err }, 'Failed to create specimen_transport indexes on startup')
    })
  }

  // POST /specimen-transport - Create transport record
  fastify.post('/specimen-transport', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const transportData = request.body as any

      if (!transportData.specimenId || !transportData.orderId || !transportData.origin || !transportData.destination) {
        reply.code(400).send({ error: 'Specimen ID, order ID, origin, and destination are required' })
        return
      }

      const now = new Date().toISOString()
      const newTransport: CouchSpecimenTransport = {
        _id: `transport_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'specimen_transport',
        specimenId: transportData.specimenId,
        orderId: transportData.orderId,
        transportType: transportData.transportType || 'internal',
        origin: transportData.origin,
        destination: transportData.destination,
        carrier: transportData.carrier,
        trackingNumber: transportData.trackingNumber,
        status: transportData.status || 'scheduled',
        temperature: transportData.temperature,
        scheduledAt: transportData.scheduledAt || now,
        pickedUpAt: transportData.pickedUpAt,
        deliveredAt: transportData.deliveredAt,
        cost: transportData.cost,
        notes: transportData.notes,
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.writeSpecimenTransport(newTransport)
      } else {
        const result = await db.insert(newTransport)
        newTransport._id = result.id
        newTransport._rev = result.rev
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('specimen-transport:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'specimen.transport.created' as any,
          newTransport._id,
          'specimen-transport',
          newTransport
        )
      )

      fastify.log.info({ id: newTransport._id, specimenId: transportData.specimenId }, 'specimen_transport.created')
      reply.code(201).send({ id: newTransport._id, rev: newTransport._rev, ...newTransport })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'specimen_transport.create_failed')
      reply.code(500).send({ error: 'Failed to create specimen transport' })
    }
  })

  // GET /specimen-transport - List transports
  fastify.get('/specimen-transport', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, status, transportType, specimenId, orderId } = request.query as any

      // Create cache key
      const cacheKey = `specimen-transport:list:${status || 'all'}:${transportType || 'all'}:${specimenId || 'all'}:${orderId || 'all'}:${limit}:${skip}`

      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'specimen_transport.list_cache_hit')
          return reply.send(cached)
        }
      }

      const selector: any = { type: 'specimen_transport' }

      if (status) selector.status = status
      if (transportType) selector.transportType = transportType
      if (specimenId) selector.specimenId = specimenId
      if (orderId) selector.orderId = orderId

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ scheduledAt: 'desc' }],
      })

      const response = { transports: result.docs, count: result.docs.length }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 5)
      }

      fastify.log.info({ count: result.docs.length }, 'specimen_transport.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'specimen_transport.list_failed')
      reply.code(500).send({ error: 'Failed to list specimen transports' })
    }
  })

  // GET /specimen-transport/:id - Get single transport
  fastify.get('/specimen-transport/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }

      // Try cache first
      const cacheKey = `specimen-transport:${id}`
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ id }, 'specimen_transport.get_cache_hit')
          return reply.send(cached)
        }
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'specimen_transport') {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, doc, 60 * 5)
      }

      fastify.log.debug({ id }, 'specimen_transport.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimen_transport.get_failed')
      reply.code(500).send({ error: 'Failed to get specimen transport' })
    }
  })

  // PUT /specimen-transport/:id - Update transport
  fastify.put('/specimen-transport/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'specimen_transport') {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.updateSpecimenTransport(id, updated)
      } else {
        await db.insert(updated)
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('specimen-transport:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'specimen.transport.updated' as any,
          id,
          'specimen-transport',
          updated
        )
      )

      fastify.log.info({ id }, 'specimen_transport.updated')
      reply.send(updated)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimen_transport.update_failed')
      reply.code(500).send({ error: 'Failed to update specimen transport' })
    }
  })

  // POST /specimen-transport/:id/track - Add tracking event
  fastify.post('/specimen-transport/:id/track', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const { status, location, temperature, notes } = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'specimen_transport') {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }

      const now = new Date().toISOString()
      const updates: any = {
        updatedAt: now,
      }

      if (status) {
        updates.status = status
        if (status === 'in-transit' && !existing.pickedUpAt) {
          updates.pickedUpAt = now
        }
        if (status === 'delivered' && !existing.deliveredAt) {
          updates.deliveredAt = now
        }
      }
      if (temperature !== undefined) updates.temperature = temperature
      if (notes) updates.notes = (existing.notes || '') + `\n[${now}] ${notes}`

      const updated = {
        ...existing,
        ...updates,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.updateSpecimenTransport(id, updated)
      } else {
        await db.insert(updated)
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('specimen-transport:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'specimen.transport.tracked' as any,
          id,
          'specimen-transport',
          { status, location, temperature }
        )
      )

      fastify.log.info({ id, status }, 'specimen_transport.tracked')
      reply.send(updated)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimen_transport.track_failed')
      reply.code(500).send({ error: 'Failed to track specimen transport' })
    }
  })

  // GET /specimen-transport/:id/status - Get current status
  fastify.get('/specimen-transport/:id/status', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'specimen_transport') {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }

      const transport = doc as any
      reply.send({
        id: transport._id,
        status: transport.status,
        location: transport.location,
        temperature: transport.temperature,
        pickedUpAt: transport.pickedUpAt,
        deliveredAt: transport.deliveredAt,
        lastUpdated: transport.updatedAt,
      })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen transport not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimen_transport.status_failed')
      reply.code(500).send({ error: 'Failed to get specimen transport status' })
    }
  })

  next()
}

