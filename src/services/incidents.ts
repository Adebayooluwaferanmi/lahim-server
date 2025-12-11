import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { randomUUID } from 'crypto'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'incidents')
  }

  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Incidents service: CouchDB not available - endpoints will return errors')
    return
  }

  const db = fastify.couch.db.use('incidents')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'incidents',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'reportedDate'] }, name: 'type-reportedDate-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'severity'] }, name: 'type-severity-index' },
      { index: { fields: ['type', 'category'] }, name: 'type-category-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'visitId'] }, name: 'type-visitId-index' },
      { index: { fields: ['type', 'department'] }, name: 'type-department-index' },
      { index: { fields: ['reportedDate'] }, name: 'reportedDate-index' },
      { index: { fields: ['incidentNumber'] }, name: 'incidentNumber-index' },
    ],
    'Incidents'
  )

  // Helper function to generate incident number
  const generateIncidentNumber = async (): Promise<string> => {
    const year = new Date().getFullYear()
    const prefix = `INC-${year}-`
    
    // Find the highest incident number for this year
    try {
      const result = await db.find({
        selector: {
          type: 'incident',
          incidentNumber: { $regex: `^${prefix}` },
        },
        limit: 1,
        sort: [{ incidentNumber: 'desc' }],
      })

      if (result.docs.length > 0) {
        const lastNumber = (result.docs[0] as any).incidentNumber
        const lastSeq = parseInt(lastNumber.replace(prefix, ''), 10) || 0
        return `${prefix}${String(lastSeq + 1).padStart(6, '0')}`
      }
    } catch (error) {
      // If no incidents found or error, start from 1
      fastify.log.warn({ error }, 'Error generating incident number, starting from 1')
    }

    return `${prefix}000001`
  }

  // ========== INCIDENTS ==========

  // GET /incidents - List incidents
  fastify.get('/incidents', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, severity, category, patientId, visitId, department } = request.query as any
      const selector: any = { type: 'incident' }

      if (status) selector.status = status
      if (severity) selector.severity = severity
      if (category) selector.category = category
      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (department) selector.department = department

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ reportedDate: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'incidents.list')
      reply.send({ incidents: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'incidents.list_failed')
      reply.code(500).send({ error: 'Failed to list incidents' })
    }
  })

  // GET /incidents/:id - Get single incident
  fastify.get('/incidents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'incident') {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }

      fastify.log.debug({ id }, 'incidents.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'incidents.get_failed')
      reply.code(500).send({ error: 'Failed to get incident' })
    }
  })

  // POST /incidents - Create incident
  fastify.post('/incidents', async (request, reply) => {
    try {
      const incident = request.body as any

      if (!incident.description || !incident.reportedBy || !incident.severity || !incident.category) {
        reply.code(400).send({ error: 'Description, reported by, severity, and category are required' })
        return
      }

      const now = new Date().toISOString()
      const incidentNumber = await generateIncidentNumber()

      const incidentDoc = {
        _id: `incident_${Date.now()}_${randomUUID()}`,
        type: 'incident',
        incidentNumber,
        reportedDate: incident.reportedDate || now,
        reportedBy: incident.reportedBy,
        status: incident.status || 'Reported',
        severity: incident.severity,
        category: incident.category,
        description: incident.description,
        location: incident.location,
        patientId: incident.patientId,
        visitId: incident.visitId,
        department: incident.department,
        investigationStartedDate: incident.investigationStartedDate,
        investigatedBy: incident.investigatedBy,
        investigationNotes: incident.investigationNotes,
        rootCause: incident.rootCause,
        resolvedDate: incident.resolvedDate,
        resolvedBy: incident.resolvedBy,
        resolution: incident.resolution,
        correctiveActions: incident.correctiveActions || [],
        preventiveActions: incident.preventiveActions || [],
        followUpRequired: incident.followUpRequired || false,
        followUpDate: incident.followUpDate,
        followUpNotes: incident.followUpNotes,
        attachments: incident.attachments || [],
        relatedIncidents: incident.relatedIncidents || [],
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(incidentDoc)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('incident.created', {
        id: result.id,
        incidentNumber,
        severity: incident.severity,
        category: incident.category,
        patientId: incident.patientId,
      })

      fastify.log.info({ id: result.id, incidentNumber }, 'incidents.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'incidents.create_failed')
      reply.code(500).send({ error: 'Failed to create incident' })
    }
  })

  // PUT /incidents/:id - Update incident
  fastify.put('/incidents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'incident') {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }

      // Auto-update status-related dates
      const now = new Date().toISOString()
      if (updates.status === 'Under Investigation' && !(existing as any).investigationStartedDate) {
        updates.investigationStartedDate = now
      }
      if (updates.status === 'Resolved' && !(existing as any).resolvedDate) {
        updates.resolvedDate = now
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: now,
      }

      const result = await db.insert(updated)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('incident.updated', {
        id,
        status: updates.status,
        changes: Object.keys(updates),
      })

      fastify.log.info({ id }, 'incidents.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'incidents.update_failed')
      reply.code(500).send({ error: 'Failed to update incident' })
    }
  })

  // DELETE /incidents/:id - Delete incident (soft delete by setting status to Cancelled)
  fastify.delete('/incidents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'incident') {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }

      // Soft delete by updating status
      const updated = {
        ...doc,
        status: 'Cancelled',
        updatedAt: new Date().toISOString(),
      }

      await db.insert(updated)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('incident.deleted', {
        id,
        incidentNumber: (doc as any).incidentNumber,
      })

      fastify.log.info({ id }, 'incidents.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'incidents.delete_failed')
      reply.code(500).send({ error: 'Failed to delete incident' })
    }
  })

  // POST /incidents/:id/start-investigation - Start investigation
  fastify.post('/incidents/:id/start-investigation', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { investigatedBy, investigationNotes } = request.body as any

      const doc = await db.get(id)
      if ((doc as any).type !== 'incident') {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }

      const updated = {
        ...doc,
        status: 'Under Investigation',
        investigationStartedDate: new Date().toISOString(),
        investigatedBy: investigatedBy || (doc as any).investigatedBy,
        investigationNotes: investigationNotes || (doc as any).investigationNotes,
        updatedAt: new Date().toISOString(),
      }

      await db.insert(updated)

      fastify.log.info({ id }, 'incidents.investigation_started')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'incidents.start_investigation_failed')
      reply.code(500).send({ error: 'Failed to start investigation' })
    }
  })

  // POST /incidents/:id/resolve - Resolve incident
  fastify.post('/incidents/:id/resolve', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { resolvedBy, resolution, correctiveActions, preventiveActions } = request.body as any

      const doc = await db.get(id)
      if ((doc as any).type !== 'incident') {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }

      const updated = {
        ...doc,
        status: 'Resolved',
        resolvedDate: new Date().toISOString(),
        resolvedBy: resolvedBy || (doc as any).resolvedBy,
        resolution: resolution || (doc as any).resolution,
        correctiveActions: correctiveActions || (doc as any).correctiveActions || [],
        preventiveActions: preventiveActions || (doc as any).preventiveActions || [],
        updatedAt: new Date().toISOString(),
      }

      await db.insert(updated)

      fastify.log.info({ id }, 'incidents.resolved')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Incident not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'incidents.resolve_failed')
      reply.code(500).send({ error: 'Failed to resolve incident' })
    }
  })

}

