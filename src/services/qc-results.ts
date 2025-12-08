import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'

const checkQCRequirement = async (
  fastify: FastifyInstance,
  testCode: string,
  instrumentId?: string,
): Promise<{ required: boolean; reason?: string }> => {
  if (!fastify.couchAvailable || !fastify.couch) {
    return { required: false, reason: 'CouchDB not available' }
  }

  try {
    const testCatalogDb = fastify.couch.db.use('test_catalog')
    const catalogResult = await testCatalogDb.find({
      selector: {
        type: 'testCatalogEntry',
        code: testCode,
        active: true,
      },
      limit: 1,
    })

    if (catalogResult.docs.length > 0) {
      const catalogEntry = catalogResult.docs[0] as any
      const qcFrequency = catalogEntry.analyticalPhases?.analytical?.qcRequirements?.frequency

      if (qcFrequency) {
        const db = fastify.couch.db.use('qc_results')
        const lastQCResult = await db.find({
          selector: {
            type: 'qc_result',
            'testCode.coding.code': testCode,
            ...(instrumentId ? { instrumentId } : {}),
          },
          sort: [{ runDate: 'desc' }],
          limit: 1,
        })

        if (lastQCResult.docs.length > 0) {
          const lastRun = new Date((lastQCResult.docs[0] as any).runDate)
          const now = new Date()
          const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60)

          switch (qcFrequency) {
            case 'per-run':
              return { required: true, reason: 'QC required per run' }
            case 'per-shift':
              return { required: hoursSinceLastRun >= 8, reason: hoursSinceLastRun >= 8 ? 'QC required per shift' : 'QC not yet required' }
            case 'per-day':
              return { required: hoursSinceLastRun >= 24, reason: hoursSinceLastRun >= 24 ? 'QC required per day' : 'QC not yet required' }
            case 'per-batch':
              return { required: true, reason: 'QC required per batch' }
            case 'per-specimen':
              return { required: true, reason: 'QC required per specimen' }
          }
        } else {
          return { required: true, reason: 'No previous QC found - QC required' }
        }
      }
    }

    return { required: false, reason: 'No QC frequency requirement defined in test catalog' }
  } catch (error: unknown) {
    fastify.log.warn({ error: error as Error, testCode }, 'Failed to check QC requirement')
    return { required: false, reason: 'Error checking QC requirement' }
  }
}

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('QC Results service: CouchDB not available - endpoints will return errors')
    next()
    return
  }

  const db = fastify.couch.db.use('qc_results')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'qc_results',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'runDate'] }, name: 'type-runDate-index' },
      { index: { fields: ['type', 'testCode.coding.code'] }, name: 'type-testCode-index' },
      { index: { fields: ['type', 'instrumentId'] }, name: 'type-instrumentId-index' },
      { index: { fields: ['runDate'] }, name: 'runDate-index' },
    ],
    'QC Results'
  )

  // GET /qc-results - List QC results
  fastify.get('/qc-results', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, testCode, instrumentId } = request.query as any
      const selector: any = { type: 'qc_result' }

      if (testCode) selector['testCode.coding.code'] = testCode
      if (instrumentId) selector.instrumentId = instrumentId

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ runDate: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'qc_results.list')
      reply.send({ results: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'qc_results.list_failed')
      reply.code(500).send({ error: 'Failed to list QC results' })
    }
  })

  // GET /qc-results/:id - Get single QC result
  fastify.get('/qc-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'qc_result') {
        reply.code(404).send({ error: 'QC result not found' })
        return
      }

      fastify.log.debug({ id }, 'qc_results.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'QC result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'qc_results.get_failed')
      reply.code(500).send({ error: 'Failed to get QC result' })
    }
  })

  // POST /qc-results - Create QC result
  fastify.post('/qc-results', async (request, reply) => {
    try {
      const qcResult = request.body as any

      if (!qcResult.testCode || !qcResult.materialId || !qcResult.result) {
        reply.code(400).send({ error: 'Test code, material ID, and result are required' })
        return
      }

      const testCodeValue = qcResult.testCode?.coding?.[0]?.code || qcResult.testCode
      const qcRequirement = await checkQCRequirement(fastify, testCodeValue, qcResult.instrumentId)

      if (!qcRequirement.required) {
        fastify.log.warn({ testCode: testCodeValue, reason: qcRequirement.reason }, 'QC result created but not required')
      }

      // Evaluate Westgard rules if mean and SD are provided
      let westgardViolations: string[] = []
      let qcStatus = 'pass'
      
      if (qcResult.targetValue && qcResult.acceptableRangeLow !== undefined && qcResult.acceptableRangeHigh !== undefined) {
        const mean = qcResult.targetValue
        const sd = (qcResult.acceptableRangeHigh - qcResult.acceptableRangeLow) / 4 // Approximate SD from range
        
        try {
          const { evaluateWestgardRules } = await import('./westgard-rules')
          
          // Get previous results for trend analysis
          const prevResult = await db.find({
            selector: {
              type: 'qc_result',
              'testCode.coding.code': testCodeValue,
              materialId: qcResult.materialId,
              ...(qcResult.instrumentId ? { instrumentId: qcResult.instrumentId } : {}),
            },
            sort: [{ runDate: 'desc' }],
            limit: 10,
          })
          
          const violations = evaluateWestgardRules(
            { ...qcResult, actualValue: qcResult.result || qcResult.actualValue },
            prevResult.docs as any[],
            mean,
            sd,
          )
          
          westgardViolations = violations.map((v) => v.rule)
          qcStatus = violations.some((v) => v.severity === 'error') ? 'fail' : violations.length > 0 ? 'warning' : 'pass'
        } catch (westgardError) {
          fastify.log.warn({ error: westgardError }, 'Failed to evaluate Westgard rules')
        }
      }

      const now = new Date().toISOString()
      const newQCResult = {
        ...qcResult,
        type: 'qc_result',
        runDate: qcResult.runDate || now,
        qcRuleViolations: westgardViolations,
        status: qcResult.status || qcStatus,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newQCResult)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        const eventType = qcStatus === 'fail' ? 'qc.result.failed' : 'qc.result.entered'
        await eventBus.publish(
          eventBus.createEvent(
            eventType as any,
            result.id,
            'qc-result',
            newQCResult,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish QC result event')
      }

      fastify.log.info({ id: result.id, testCode: testCodeValue, status: qcStatus, violations: westgardViolations.length }, 'qc_results.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newQCResult })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'qc_results.create_failed')
      reply.code(500).send({ error: 'Failed to create QC result' })
    }
  })

  // GET /qc-results/check-requirement - Check if QC is required for a test
  fastify.get('/qc-results/check-requirement', async (request, reply) => {
    try {
      const { testCode, instrumentId } = request.query as any

      if (!testCode) {
        reply.code(400).send({ error: 'Test code is required' })
        return
      }

      const requirement = await checkQCRequirement(fastify, testCode, instrumentId)
      reply.send(requirement)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'qc_results.check_requirement_failed')
      reply.code(500).send({ error: 'Failed to check QC requirement' })
    }
  })

  next()
}

