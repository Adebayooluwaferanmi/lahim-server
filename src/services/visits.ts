import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'visits')
  }

  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Visits service: CouchDB not available - endpoints will return errors')
    return
  }

  const db = fastify.couch.db.use('visits')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'visits',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'startDate'] }, name: 'type-startDate-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['startDate'] }, name: 'startDate-index' },
    ],
    'Visits'
  )

  // GET /visits - List visits
  fastify.get('/visits', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId, visitType, startDate, endDate } = request.query as any
      const selector: any = { type: 'visit' }

      if (status) selector.status = status
      if (patientId) selector.patientId = patientId
      if (visitType) selector.visitType = visitType
      if (startDate || endDate) {
        selector.startDate = {}
        if (startDate) selector.startDate.$gte = startDate
        if (endDate) selector.startDate.$lte = endDate
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ startDate: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'visits.list')
      reply.send({ visits: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'visits.list_failed')
      reply.code(500).send({ error: 'Failed to list visits' })
    }
  })

  // GET /visits/:id - Get single visit
  fastify.get('/visits/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'visit') {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }

      fastify.log.debug({ id }, 'visits.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'visits.get_failed')
      reply.code(500).send({ error: 'Failed to get visit' })
    }
  })

  // POST /visits - Create visit
  fastify.post('/visits', async (request, reply) => {
    try {
      const visit = request.body as any

      if (!visit.patientId || !visit.startDate || !visit.visitType) {
        reply.code(400).send({ error: 'Patient ID, start date, and visit type are required' })
        return
      }

      const now = new Date().toISOString()
      const newVisit = {
        ...visit,
        type: 'visit',
        status: visit.status || 'InProgress',
        paymentState: visit.paymentState || 'pending',
        outPatient: visit.outPatient !== undefined ? visit.outPatient : visit.visitType !== 'Inpatient',
        hasAppointment: visit.hasAppointment || false,
        createdAt: now,
        updatedAt: now,
        vitals: visit.vitals || [],
        procedures: visit.procedures || [],
        patientNotes: visit.patientNotes || [],
        medication: visit.medication || [],
        labs: visit.labs || [],
        imaging: visit.imaging || [],
        diagnoses: visit.diagnoses || [],
        charges: visit.charges || [],
        reports: visit.reports || [],
      }

      const result = await db.insert(newVisit)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'visit.created',
            result.id,
            'visit',
            newVisit,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish visit created event')
      }

      fastify.log.info({ id: result.id, patientId: visit.patientId }, 'visits.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newVisit })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'visits.create_failed')
      reply.code(500).send({ error: 'Failed to create visit' })
    }
  })

  // PUT /visits/:id - Update visit
  fastify.put('/visits/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      // Get existing visit
      const existing = await db.get(id)
      if ((existing as any).type !== 'visit') {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }

      const updatedVisit = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updatedVisit)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'visit.updated',
            id,
            'visit',
            updatedVisit,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish visit updated event')
      }

      fastify.log.info({ id }, 'visits.updated')
      reply.send({ id: result.id, rev: result.rev, ...updatedVisit })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'visits.update_failed')
      reply.code(500).send({ error: 'Failed to update visit' })
    }
  })

  // POST /visits/:id/admit - Admit patient (for inpatient visits)
  fastify.post('/visits/:id/admit', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { admissionDate, room, bed } = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'visit') {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }

      const updatedVisit = {
        ...existing,
        _id: id,
        _rev: (existing as any)._rev,
        status: 'Admitted',
        outPatient: false,
        visitType: 'Inpatient',
        startDate: admissionDate || (existing as any).startDate || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        admissionInfo: {
          admissionDate: admissionDate || new Date().toISOString(),
          room,
          bed,
        },
      }

      const result = await db.insert(updatedVisit)

      fastify.log.info({ id }, 'visits.admitted')
      reply.send({ id: result.id, rev: result.rev, ...updatedVisit })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'visits.admit_failed')
      reply.code(500).send({ error: 'Failed to admit patient' })
    }
  })

  // POST /visits/:id/discharge - Discharge patient
  fastify.post('/visits/:id/discharge', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { dischargeDate, dischargeNotes, dischargeDiagnosis } = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'visit') {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }

      const now = new Date().toISOString()
      const updatedVisit = {
        ...existing,
        _id: id,
        _rev: (existing as any)._rev,
        status: 'Discharged',
        endDate: dischargeDate || now,
        updatedAt: now,
        dischargeInfo: {
          dischargeDate: dischargeDate || now,
          dischargeNotes,
          dischargeDiagnosis,
        },
      }

      const result = await db.insert(updatedVisit)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'visit.discharged',
            id,
            'visit',
            updatedVisit,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish visit discharged event')
      }

      fastify.log.info({ id }, 'visits.discharged')
      reply.send({ id: result.id, rev: result.rev, ...updatedVisit })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'visits.discharge_failed')
      reply.code(500).send({ error: 'Failed to discharge patient' })
    }
  })

  // DELETE /visits/:id - Soft delete visit
  fastify.delete('/visits/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const existing = await db.get(id)

      if ((existing as any).type !== 'visit') {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }

      // Soft delete by setting archived flag
      const deletedVisit = {
        ...existing,
        _id: id,
        _rev: (existing as any)._rev,
        archived: true,
        updatedAt: new Date().toISOString(),
      }

      await db.insert(deletedVisit)

      fastify.log.info({ id }, 'visits.deleted')
      reply.send({ message: 'Visit deleted successfully' })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Visit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'visits.delete_failed')
      reply.code(500).send({ error: 'Failed to delete visit' })
    }
  })

}

