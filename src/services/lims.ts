import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('lab_results')
  const testCatalogDb = fastify.couch.db.use('test_catalog')

  // GET /lab-results - List lab results
  fastify.get('/lab-results', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, patientId, testCode, status, startDate, endDate } = request.query as any
      const selector: any = { type: 'lab_result' }

      if (patientId) selector.patientId = patientId
      if (testCode) selector['testCode.coding.code'] = testCode
      if (status) selector.status = status
      if (startDate || endDate) {
        selector.reportedDateTime = {}
        if (startDate) selector.reportedDateTime.$gte = startDate
        if (endDate) selector.reportedDateTime.$lte = endDate
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ reportedDateTime: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'lab_results.list')
      reply.send({ results: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_results.list_failed')
      reply.code(500).send({ error: 'Failed to list lab results' })
    }
  })

  // GET /lab-results/:id - Get single lab result
  fastify.get('/lab-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      fastify.log.debug({ id }, 'lab_results.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.get_failed')
      reply.code(500).send({ error: 'Failed to get lab result' })
    }
  })

  // POST /lab-results - Create lab result with auto-validation
  fastify.post('/lab-results', async (request, reply) => {
    try {
      const result = request.body as any

      if (!result.patientId || !result.testCode || !result.resultType) {
        reply.code(400).send({ error: 'Patient ID, test code, and result type are required' })
        return
      }

      // Fetch test catalog entry for auto-validation rules
      let validationErrors: string[] = []
      const testCodeValue = result.testCode?.coding?.[0]?.code || result.testCode
      
      if (testCodeValue) {
        try {
          const catalogResult = await testCatalogDb.find({
            selector: {
              type: 'testCatalogEntry',
              code: testCodeValue,
              active: true,
            },
            limit: 1,
          })

          if (catalogResult.docs.length > 0) {
            const catalogEntry = catalogResult.docs[0] as any
            const validationRules = catalogEntry.analyticalPhases?.analytical?.validationRules

            // Auto-validation for numeric results
            if (result.resultType === 'numeric' && result.numericValue !== undefined) {
              if (validationRules?.minValue !== undefined && result.numericValue < validationRules.minValue) {
                validationErrors.push(`Value ${result.numericValue} is below minimum ${validationRules.minValue}`)
              }
              if (validationRules?.maxValue !== undefined && result.numericValue > validationRules.maxValue) {
                validationErrors.push(`Value ${result.numericValue} is above maximum ${validationRules.maxValue}`)
              }
              if (validationRules?.withinReferenceRange && result.referenceRange) {
                const { low, high } = result.referenceRange
                if (low !== undefined && result.numericValue < low) {
                  validationErrors.push(`Value ${result.numericValue} is below reference range (${low}-${high})`)
                }
                if (high !== undefined && result.numericValue > high) {
                  validationErrors.push(`Value ${result.numericValue} is above reference range (${low}-${high})`)
                }
              }
            }
          }
        } catch (catalogError) {
          fastify.log.warn({ error: catalogError, testCode: testCodeValue }, 'Failed to fetch test catalog for validation')
        }
      }

      if (validationErrors.length > 0) {
        reply.code(400).send({ error: 'Validation failed', validationErrors })
        return
      }

      const now = new Date().toISOString()
      const newResult = {
        ...result,
        type: 'lab_result',
        status: result.status || 'final',
        reportedDateTime: result.reportedDateTime || now,
        createdAt: now,
        updatedAt: now,
      }

      const insertResult = await db.insert(newResult)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        const eventType = newResult.status === 'final' ? 'lab.result.finalized' : 'lab.result.created'
        await eventBus.publish(
          eventBus.createEvent(
            eventType as any,
            insertResult.id,
            'lab-result',
            newResult,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab result event')
      }

      // Check for critical values (async, don't block result creation)
      if (result.resultType === 'numeric' && result.numericValue !== undefined) {
        setImmediate(async () => {
          try {
            // Note: Critical value check would be handled by the service itself
            // This is just a placeholder for async notification
            fastify.log.info({ resultId: insertResult.id }, 'critical_value_check_queued')
          } catch (error: unknown) {
            fastify.log.warn({ error, resultId: insertResult.id }, 'Failed to check critical value')
          }
        })
      }

      fastify.log.info({ id: insertResult.id, patientId: result.patientId }, 'lab_results.created')
      reply.code(201).send({ id: insertResult.id, rev: insertResult.rev, ...newResult })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_results.create_failed')
      reply.code(500).send({ error: 'Failed to create lab result' })
    }
  })

  // PUT /lab-results/:id - Update lab result
  fastify.put('/lab-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      fastify.log.info({ id }, 'lab_results.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.update_failed')
      reply.code(500).send({ error: 'Failed to update lab result' })
    }
  })

  next()
}

