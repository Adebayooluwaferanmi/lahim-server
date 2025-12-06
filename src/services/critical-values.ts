import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('critical_values')
    : null
  const labResultsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('lab_results')
    : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'critical_values',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'detectedOn'] }, name: 'type-detectedOn-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
    ],
    'Critical values'
  )

  // GET /critical-values - List critical values
  fastify.get('/critical-values', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, status, patientId } = request.query as any
      const selector: any = { type: 'critical_value' }

      if (status) selector.status = status
      if (patientId) selector.patientId = patientId

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ detectedOn: 'desc' }], // Sort by detectedOn desc only (CouchDB doesn't support mixed directions)
      })

      fastify.log.info({ count: result.docs.length }, 'critical_values.list')
      reply.send({ criticalValues: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'critical_values.list_failed')
      reply.code(500).send({ error: 'Failed to list critical values' })
    }
  })

  // GET /critical-values/:id - Get single critical value
  fastify.get('/critical-values/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'critical_value') {
        reply.code(404).send({ error: 'Critical value not found' })
        return
      }

      fastify.log.debug({ id }, 'critical_values.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Critical value not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'critical_values.get_failed')
      reply.code(500).send({ error: 'Failed to get critical value' })
    }
  })

  // POST /critical-values/check - Check if a result is critical
  fastify.post('/critical-values/check', async (request, reply) => {
    if (!db || !labResultsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { resultId } = request.body as { resultId: string }

      if (!resultId) {
        reply.code(400).send({ error: 'Result ID is required' })
        return
      }

      const result = await labResultsDb.get(resultId) as any

      if (result.type !== 'lab_result' || result.resultType !== 'numeric') {
        reply.send({ isCritical: false, reason: 'Result is not numeric' })
        return
      }

      // In a real implementation, this would check against test catalog critical value ranges
      // For now, we'll create a critical value record if the value is outside reference range
      const isCritical = result.referenceRange &&
        (result.numericValue < result.referenceRange.low || result.numericValue > result.referenceRange.high)

      if (isCritical) {
        const now = new Date().toISOString()
        const criticalValue: any = {
          type: 'critical_value',
          resultId,
          patientId: result.patientId,
          testCode: result.testCode,
          testName: result.testName,
          value: result.numericValue,
          unit: result.unit,
          referenceRange: result.referenceRange,
          status: 'pending',
          detectedOn: now,
          createdAt: now,
          updatedAt: now,
        }

        const insertResult = await db.insert(criticalValue)

        fastify.log.warn({ id: insertResult.id, resultId, patientId: result.patientId }, 'critical_value.detected')
        reply.send({ isCritical: true, criticalValueId: insertResult.id, ...criticalValue })
      } else {
        reply.send({ isCritical: false })
      }
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Result not found' })
        return
      }
      fastify.log.error(error as Error, 'critical_values.check_failed')
      reply.code(500).send({ error: 'Failed to check critical value' })
    }
  })

  // PUT /critical-values/:id/acknowledge - Acknowledge critical value
  fastify.put('/critical-values/:id/acknowledge', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const { acknowledgedBy, notes } = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'critical_value') {
        reply.code(404).send({ error: 'Critical value not found' })
        return
      }

      const updated = {
        ...existing,
        status: 'acknowledged',
        acknowledgedBy: acknowledgedBy || 'system',
        acknowledgedOn: new Date().toISOString(),
        notes: notes || existing.notes,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      fastify.log.info({ id, acknowledgedBy }, 'critical_values.acknowledged')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Critical value not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'critical_values.acknowledge_failed')
      reply.code(500).send({ error: 'Failed to acknowledge critical value' })
    }
  })

  next()
}

