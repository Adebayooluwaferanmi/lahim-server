import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

/**
 * Pharmacy Integration Service
 * 
 * Manages pharmacy relationships, prescription routing, and refill requests
 */

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'pharmacies')
    await ensureCouchDBDatabase(fastify, 'prescription_routing')
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Pharmacy service: CouchDB not available - registering stub endpoints')
    
    // Register stub endpoints that return empty arrays to prevent 404 errors
    fastify.get('/pharmacies', async (_request, reply) => {
      reply.send({ pharmacies: [], count: 0 })
    })
    
    fastify.post('/pharmacies', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.post('/prescriptions/:id/route-to-pharmacy', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/prescriptions/:id/pharmacy-status', async (_request, reply) => {
      reply.send({ routed: false })
    })
    
    return
  }

  const pharmaciesDb = fastify.couch.db.use('pharmacies')
  const routingDb = fastify.couch.db.use('prescription_routing')

  createCouchDBIndexes(
    fastify,
    'pharmacies',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
    ],
    'Pharmacies'
  )

  createCouchDBIndexes(
    fastify,
    'prescription_routing',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'prescriptionId'] }, name: 'type-prescriptionId-index' },
      { index: { fields: ['type', 'pharmacyId'] }, name: 'type-pharmacyId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Prescription Routing'
  )

  // GET /pharmacies - List pharmacies
  fastify.get('/pharmacies', async (request, reply) => {
    try {
      const { active, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'pharmacy' }

      if (active !== undefined) selector.active = active === 'true'

      const result = await pharmaciesDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      reply.send({ pharmacies: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'pharmacies.list_failed')
      reply.code(500).send({ error: 'Failed to list pharmacies' })
    }
  })

  // POST /pharmacies - Create pharmacy
  fastify.post('/pharmacies', async (request, reply) => {
    try {
      const pharmacy = request.body as any
      const now = new Date().toISOString()

      const newPharmacy = {
        ...pharmacy,
        type: 'pharmacy',
        active: pharmacy.active !== undefined ? pharmacy.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await pharmaciesDb.insert(newPharmacy)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newPharmacy })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'pharmacies.create_failed')
      reply.code(500).send({ error: 'Failed to create pharmacy' })
    }
  })

  // POST /prescriptions/:id/route-to-pharmacy - Route prescription to pharmacy
  fastify.post('/prescriptions/:id/route-to-pharmacy', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { pharmacyId, notes } = request.body as any

      if (!pharmacyId) {
        reply.code(400).send({ error: 'Pharmacy ID is required' })
        return
      }

      const now = new Date().toISOString()
      const routing = {
        _id: `routing_${Date.now()}_${id}`,
        type: 'prescription_routing',
        prescriptionId: id,
        pharmacyId,
        status: 'sent',
        sentDate: now,
        notes,
        createdAt: now,
        updatedAt: now,
      }

      const result = await routingDb.insert(routing)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('prescription.routed', {
        prescriptionId: id,
        pharmacyId,
      })

      reply.code(201).send({ id: result.id, rev: result.rev, ...routing })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'prescription.routing_failed')
      reply.code(500).send({ error: 'Failed to route prescription' })
    }
  })

  // GET /prescriptions/:id/pharmacy-status - Get prescription pharmacy status
  fastify.get('/prescriptions/:id/pharmacy-status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      const result = await routingDb.find({
        selector: {
          type: 'prescription_routing',
          prescriptionId: id,
        },
        sort: [{ sentDate: 'desc' }],
        limit: 1,
      })

      if (result.docs.length === 0) {
        reply.send({ routed: false })
        return
      }

      const routing = result.docs[0] as any
      const pharmacy = await pharmaciesDb.get(routing.pharmacyId)

      reply.send({
        routed: true,
        pharmacy,
        routing,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'prescription.pharmacy_status_failed')
      reply.code(500).send({ error: 'Failed to get pharmacy status' })
    }
  })
}

