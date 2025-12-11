import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'
import { eventBus } from '../lib/event-bus'
import { createSpecimenDualWriteHelper } from '../lib/dual-write-helpers/specimen-dual-write'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'

const addChainOfCustody = (specimen: any, action: string, performedBy: string, location: string, notes?: string) => {
  const chain = specimen.chainOfCustody || []
  chain.push({
    action,
    performedBy,
    location,
    performedOn: new Date().toISOString(),
    notes,
  })
  return chain
}

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('specimens')
    : null
  const cache = createMetricsCacheHelper(fastify, 'specimens')
  const dualWrite = fastify.prisma ? createSpecimenDualWriteHelper(fastify) : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'specimens',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'collectedOn'] }, name: 'type-collectedOn-index' },
      { index: { fields: ['collectedOn'] }, name: 'collectedOn-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'orderId'] }, name: 'type-orderId-index' },
    ],
    'Specimens'
  )

  // GET /specimens - List specimens
  fastify.get('/specimens', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, status, patientId, orderId } = request.query as any
      
      // Create cache key
      const cacheKey = `specimens:${status || 'all'}:${patientId || 'all'}:${orderId || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'specimens.list_cache_hit')
        return reply.send(cached)
      }

      // Try PostgreSQL first (if available), fallback to CouchDB
      let specimens: any[] = []
      let total = 0

      if (fastify.prisma) {
        try {
          const where: any = {}
          if (orderId) where.orderId = orderId
          // Note: status and patientId filters would need to be done via order relation
          // For now, we'll filter by orderId primarily

          const [labSpecimens, count] = await Promise.all([
            fastify.prisma.labSpecimen.findMany({
              where,
              take: parseInt(limit, 10),
              skip: parseInt(skip, 10),
              orderBy: { collectedAt: 'desc' },
              include: {
                order: {
                  include: {
                    patient: true,
                  },
                },
                results: true,
                transports: true,
              },
            }),
            fastify.prisma.labSpecimen.count({ where }),
          ])

          // Map Prisma results to CouchDB-like format for compatibility
          specimens = labSpecimens.map((specimen: any) => {
            const couchSpecimen: any = {
              _id: specimen.id,
              _rev: '1-xxx', // Placeholder for CouchDB revision
              type: 'specimen',
              orderId: specimen.orderId,
              specimenTypeCode: specimen.specimenTypeCode,
              specimenType: {
                coding: [{ code: specimen.specimenTypeCode }],
              },
              collectedOn: specimen.collectedAt?.toISOString(),
              container: specimen.container,
              accessionNo: specimen.accessionNo,
              storageLocation: specimen.storageLocation,
              createdAt: specimen.createdAt?.toISOString(),
              updatedAt: specimen.updatedAt?.toISOString(),
            }

            // Add patient info from order if available
            if (specimen.order?.patient) {
              couchSpecimen.patientId = specimen.order.patient.patientId
              couchSpecimen.patientName = `${specimen.order.patient.firstName || ''} ${specimen.order.patient.lastName || ''}`.trim()
            }

            // Add order status if available
            if (specimen.order) {
              couchSpecimen.status = specimen.order.status || 'collected'
            }

            return couchSpecimen
          })

          // Apply additional filters if needed (patientId via order relation)
          if (patientId) {
            specimens = specimens.filter((s: any) => s.patientId === patientId)
          }
          if (status) {
            specimens = specimens.filter((s: any) => s.status === status)
          }

          total = specimens.length
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL Specimens query failed, falling back to CouchDB')
          // Fall through to CouchDB query
        }
      }

      // Fallback to CouchDB if PostgreSQL not available or failed
      if (specimens.length === 0 && total === 0) {
        const selector: any = { type: 'specimen' }

        if (status) selector.status = status
        if (patientId) selector.patientId = patientId
        if (orderId) selector.orderId = orderId

        const result = await db.find({
          selector,
          limit: parseInt(limit, 10),
          skip: parseInt(skip, 10),
          sort: [{ collectedOn: 'desc' }],
        })

        specimens = result.docs
        total = result.docs.length
      }

      const response = { specimens, count: specimens.length, total, limit: parseInt(limit, 10), skip: parseInt(skip, 10) }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: specimens.length }, 'specimens.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'specimens.list_failed')
      reply.code(500).send({ error: 'Failed to list specimens' })
    }
  })

  // GET /specimens/:id - Get single specimen
  fastify.get('/specimens/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      
      // Create cache key
      const cacheKey = `specimen:${id}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'specimens.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'specimen') {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, doc, 300)

      fastify.log.debug({ id }, 'specimens.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimens.get_failed')
      reply.code(500).send({ error: 'Failed to get specimen' })
    }
  })

  // POST /specimens/:id/register - Register/receive specimen
  fastify.post('/specimens/:id/register', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const {
        integrityCheck,
        labelingCheck,
        receptionNotes,
        storageLocation,
        storageTemperature,
        receivedBy,
        status,
      } = request.body as any

      const existing = await db.get(id) as any
      if (existing.type !== 'specimen') {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }

      const now = new Date().toISOString()
      const updates: any = {
        reception: {
          ...existing.reception,
          integrityCheck: integrityCheck !== undefined ? integrityCheck : existing.reception?.integrityCheck,
          labelingCheck: labelingCheck !== undefined ? labelingCheck : existing.reception?.labelingCheck,
          receptionNotes: receptionNotes || existing.reception?.receptionNotes,
          storageLocation: storageLocation || existing.reception?.storageLocation,
          storageTemperature: storageTemperature || existing.reception?.storageTemperature,
          receivedBy: receivedBy || existing.reception?.receivedBy,
          receivedOn: existing.reception?.receivedOn || now,
        },
        status: status || 'received',
        updatedAt: now,
      }

      if (!existing.reception?.receivedOn && receivedBy) {
        updates.chainOfCustody = addChainOfCustody(
          existing,
          'received',
          receivedBy,
          storageLocation || 'Reception Area',
          receptionNotes,
        )
      }

      const updated = { ...existing, ...updates }

      // Use dual-write if available
      let updateResult: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.updateSpecimen(id, updates, {
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
            updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            updateResult = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || id,
              rev: dualWriteResult.couch.rev || existing._rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write update error, falling back to CouchDB only')
          const fallbackResult = await db.insert(updated)
          updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(updated)
        updateResult = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.delete(`specimen:${id}`)
      await cache.deletePattern('specimens:*')

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'specimen.received',
            id,
            'specimen',
            updated,
            { userId: receivedBy }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish specimen received event')
      }

      fastify.log.info({ id, receivedBy }, 'specimens.registered')
      reply.send({ id: updateResult.id, rev: updateResult.rev, status: updated.status })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimens.register_failed')
      reply.code(500).send({ error: 'Failed to register specimen' })
    }
  })

  // POST /specimens/:id/process - Process specimen (centrifugation, pre-analytical QC)
  fastify.post('/specimens/:id/process', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const {
        centrifuged,
        centrifugedBy,
        centrifugationTime,
        centrifugationSpeed,
        preAnalyticalQC,
        processedBy,
        status,
      } = request.body as any

      const existing = await db.get(id) as any
      if (existing.type !== 'specimen') {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }

      if (existing.status !== 'received' && existing.status !== 'processing') {
        reply.code(400).send({
          error: 'Specimen must be in received or processing status to process',
          currentStatus: existing.status,
        })
        return
      }

      const now = new Date().toISOString()
      const updates: any = {
        processing: {
          ...existing.processing,
          centrifuged: centrifuged !== undefined ? centrifuged : existing.processing?.centrifuged,
          centrifugedBy: centrifugedBy || existing.processing?.centrifugedBy,
          centrifugationTime: centrifugationTime || existing.processing?.centrifugationTime,
          centrifugationSpeed: centrifugationSpeed || existing.processing?.centrifugationSpeed,
          preAnalyticalQC: preAnalyticalQC
            ? { ...existing.processing?.preAnalyticalQC, ...preAnalyticalQC, checkedOn: preAnalyticalQC.checkedOn || now }
            : existing.processing?.preAnalyticalQC,
          processedBy: processedBy || existing.processing?.processedBy,
          processedOn: status === 'processed' && !existing.processing?.processedOn ? now : existing.processing?.processedOn,
        },
        status: status || existing.status,
        updatedAt: now,
      }

      if (centrifuged && !existing.processing?.centrifugedOn) {
        updates.processing.centrifugedOn = now
        updates.chainOfCustody = addChainOfCustody(
          existing,
          'centrifuged',
          centrifugedBy || 'system',
          'Processing Area',
          'Centrifugation completed',
        )
      }

      if (status === 'processed' && !existing.processing?.processedOn) {
        updates.chainOfCustody = addChainOfCustody(
          existing,
          'processed',
          processedBy || 'system',
          'Processing Area',
          'Specimen processing completed',
        )
      }

      const updated = { ...existing, ...updates }

      // Use dual-write if available
      let updateResult: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.updateSpecimen(id, updates, {
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
            updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            updateResult = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || id,
              rev: dualWriteResult.couch.rev || existing._rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write update error, falling back to CouchDB only')
          const fallbackResult = await db.insert(updated)
          updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(updated)
        updateResult = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.delete(`specimen:${id}`)
      await cache.deletePattern('specimens:*')

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'specimen.processed',
            id,
            'specimen',
            updated,
            { userId: processedBy }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish specimen processed event')
      }

      fastify.log.info({ id, status: updated.status, processedBy: updated.processing?.processedBy }, 'specimens.processed')
      reply.send({ id: updateResult.id, rev: updateResult.rev, status: updated.status })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimens.process_failed')
      reply.code(500).send({ error: 'Failed to process specimen' })
    }
  })

  // POST /specimens/:id/aliquots - Create aliquots
  fastify.post('/specimens/:id/aliquots', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const { aliquots, createdBy } = request.body as any

      if (!aliquots || !Array.isArray(aliquots) || aliquots.length === 0) {
        reply.code(400).send({ error: 'Aliquots array is required' })
        return
      }

      const existing = await db.get(id) as any
      if (existing.type !== 'specimen') {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }

      const now = new Date().toISOString()
      const newAliquots = aliquots.map((aliquot: any) => ({
        ...aliquot,
        id: aliquot.id || `aliquot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdOn: now,
        createdBy: createdBy || 'system',
        parentSpecimenId: id,
      }))

      const updated = {
        ...existing,
        aliquots: [...(existing.aliquots || []), ...newAliquots],
        updatedAt: now,
      }

      // Use dual-write if available
      let updateResult: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.updateSpecimen(id, {
            aliquots: updated.aliquots,
            updatedAt: now,
          }, {
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
            updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            updateResult = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || id,
              rev: dualWriteResult.couch.rev || existing._rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write update error, falling back to CouchDB only')
          const fallbackResult = await db.insert(updated)
          updateResult = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(updated)
        updateResult = { id: insertResult.id, rev: insertResult.rev }
      }

      // Also create separate aliquot records in CouchDB (for compatibility)
      for (const aliquot of newAliquots) {
        try {
        await db.insert({
          ...aliquot,
          type: 'specimen_aliquot',
          specimenId: id,
        })
        } catch (error) {
          fastify.log.warn({ error, aliquotId: aliquot.id }, 'Failed to create separate aliquot record')
        }
      }

      fastify.log.info({ id, count: newAliquots.length }, 'specimens.aliquots_created')
      reply.send({ id: updateResult.id, rev: updateResult.rev, aliquots: newAliquots })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'specimens.aliquots_failed')
      reply.code(500).send({ error: 'Failed to create aliquots' })
    }
  })

  next()
}

