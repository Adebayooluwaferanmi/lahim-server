import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'medications')
    await ensureCouchDBDatabase(fastify, 'prescriptions')
  }

  // Only create database references if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Medications service: CouchDB not available - endpoints will return errors')
    return
  }

  const medicationsDb = fastify.couch.db.use('medications')
  const prescriptionsDb = fastify.couch.db.use('prescriptions')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'medications',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Medications'
  )
  createCouchDBIndexes(
    fastify,
    'prescriptions',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'startDate'] }, name: 'type-startDate-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['startDate'] }, name: 'startDate-index' },
    ],
    'Prescriptions'
  )
  // const administrationsDb = fastify.couch.db.use('medication_administrations') // Reserved for future use

  // ========== MEDICATIONS (Catalog) ==========

  // GET /medications - List medications
  fastify.get('/medications', async (request, reply) => {
    try {
      const { search, type, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'medication' }

      if (type) selector.medicationType = type
      if (search) {
        selector.$or = [
          { name: { $regex: search, $options: 'i' } },
          { genericName: { $regex: search, $options: 'i' } },
          { brandName: { $regex: search, $options: 'i' } },
        ]
      }

      const result = await medicationsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      reply.send({ medications: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'medications.list_failed')
      reply.code(500).send({ error: 'Failed to list medications' })
    }
  })

  // GET /medications/:id - Get single medication
  fastify.get('/medications/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await medicationsDb.get(id)

      if ((doc as any).type !== 'medication') {
        reply.code(404).send({ error: 'Medication not found' })
        return
      }

      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Medication not found' })
        return
      }
      fastify.log.error(error as Error, 'medications.get_failed')
      reply.code(500).send({ error: 'Failed to get medication' })
    }
  })

  // POST /medications - Create medication
  fastify.post('/medications', async (request, reply) => {
    try {
      const medication = request.body as any

      if (!medication.name) {
        reply.code(400).send({ error: 'Medication name is required' })
        return
      }

      const now = new Date().toISOString()
      const newMedication = {
        ...medication,
        type: 'medication',
        createdAt: now,
        updatedAt: now,
      }

      const result = await medicationsDb.insert(newMedication)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newMedication })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'medications.create_failed')
      reply.code(500).send({ error: 'Failed to create medication' })
    }
  })

  // PUT /medications/:id - Update medication
  fastify.put('/medications/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await medicationsDb.get(id)
      if ((existing as any).type !== 'medication') {
        reply.code(404).send({ error: 'Medication not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: new Date().toISOString(),
      }

      const result = await medicationsDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Medication not found' })
        return
      }
      fastify.log.error(error as Error, 'medications.update_failed')
      reply.code(500).send({ error: 'Failed to update medication' })
    }
  })

  // ========== PRESCRIPTIONS ==========

  // GET /prescriptions - List prescriptions
  fastify.get('/prescriptions', async (request, reply) => {
    try {
      const { patientId, visitId, status, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'prescription' }

      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (status) selector.status = status

      const result = await prescriptionsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ startDate: 'desc' }],
      })

      reply.send({ prescriptions: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'prescriptions.list_failed')
      reply.code(500).send({ error: 'Failed to list prescriptions' })
    }
  })

  // GET /prescriptions/:id - Get single prescription
  fastify.get('/prescriptions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await prescriptionsDb.get(id)

      if ((doc as any).type !== 'prescription') {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }

      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }
      fastify.log.error(error as Error, 'prescriptions.get_failed')
      reply.code(500).send({ error: 'Failed to get prescription' })
    }
  })

  // POST /prescriptions - Create prescription
  fastify.post('/prescriptions', async (request, reply) => {
    try {
      const prescription = request.body as any

      if (!prescription.patientId || !prescription.medicationName || !prescription.startDate) {
        reply.code(400).send({ error: 'Patient ID, medication name, and start date are required' })
        return
      }

      const now = new Date().toISOString()
      const newPrescription = {
        ...prescription,
        type: 'prescription',
        status: prescription.status || 'active',
        refillsRemaining: prescription.refills || 0,
        createdAt: now,
        updatedAt: now,
      }

      const result = await prescriptionsDb.insert(newPrescription)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'prescription.created',
            result.id,
            'prescription',
            newPrescription,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish prescription created event')
      }

      reply.code(201).send({ id: result.id, rev: result.rev, ...newPrescription })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'prescriptions.create_failed')
      reply.code(500).send({ error: 'Failed to create prescription' })
    }
  })

  // PUT /prescriptions/:id - Update prescription
  fastify.put('/prescriptions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await prescriptionsDb.get(id)
      if ((existing as any).type !== 'prescription') {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: new Date().toISOString(),
      }

      const result = await prescriptionsDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }
      fastify.log.error(error as Error, 'prescriptions.update_failed')
      reply.code(500).send({ error: 'Failed to update prescription' })
    }
  })

  // POST /prescriptions/:id/discontinue - Discontinue prescription
  fastify.post('/prescriptions/:id/discontinue', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { reason } = request.body as any

      const existing = await prescriptionsDb.get(id)
      if ((existing as any).type !== 'prescription') {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }

      const updated = {
        ...existing,
        _id: id,
        _rev: (existing as any)._rev,
        status: 'discontinued',
        endDate: new Date().toISOString(),
        notes: reason ? `${(existing as any).notes || ''}\nDiscontinued: ${reason}`.trim() : (existing as any).notes,
        updatedAt: new Date().toISOString(),
      }

      const result = await prescriptionsDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Prescription not found' })
        return
      }
      fastify.log.error(error as Error, 'prescriptions.discontinue_failed')
      reply.code(500).send({ error: 'Failed to discontinue prescription' })
    }
  })

}

