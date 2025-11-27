import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { nextCallback } from 'fastify-plugin'

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
  next: nextCallback,
) => {
  const db = fastify.couch.db.use('specimens')

  // GET /specimens - List specimens
  fastify.get('/specimens', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId, orderId } = request.query as any
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

      fastify.log.info({ count: result.docs.length }, 'specimens.list')
      reply.send({ specimens: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'specimens.list_failed')
      reply.code(500).send({ error: 'Failed to list specimens' })
    }
  })

  // GET /specimens/:id - Get single specimen
  fastify.get('/specimens/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'specimen') {
        reply.code(404).send({ error: 'Specimen not found' })
        return
      }

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
      const updateResult = await db.insert(updated)

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
      const updateResult = await db.insert(updated)

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

      const updateResult = await db.insert(updated)

      // Also create separate aliquot records
      for (const aliquot of newAliquots) {
        await db.insert({
          ...aliquot,
          type: 'specimen_aliquot',
          specimenId: id,
        })
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

