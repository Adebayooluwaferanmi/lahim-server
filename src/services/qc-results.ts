import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { QCResultDualWriteHelper } from '../lib/dual-write-helpers/qc-result-dual-write'

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
  const cache = createMetricsCacheHelper(fastify, 'qc-results')
  
  // Initialize dual-write helper if both databases are available
  const dualWrite = fastify.prisma && fastify.couchAvailable && fastify.couch
    ? new QCResultDualWriteHelper(
        fastify,
        fastify.couch.db.use('qc_results'),
        fastify.prisma
      )
    : null
  
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

  // GET /qc-results - List QC results (with caching and PostgreSQL migration)
  fastify.get('/qc-results', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, testCode, instrumentId } = request.query as any
      
      // Create cache key
      const cacheKey = `qc-results:${testCode || 'all'}:${instrumentId || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'qc_results.list_cache_hit')
        return reply.send(cached)
      }

      // Try PostgreSQL first (if available), fallback to CouchDB
      let results: any[] = []
      let total = 0

      if (fastify.prisma) {
        try {
          const where: any = {}
          if (testCode) where.testCodeLoinc = testCode
          if (instrumentId) where.instrumentId = instrumentId

          const [qcResults, count] = await Promise.all([
            fastify.prisma.qcResult.findMany({
              where,
              take: parseInt(limit, 10),
              skip: parseInt(skip, 10),
              orderBy: { runAt: 'desc' },
              include: {
                instrument: true,
                testCatalog: true,
                performer: true,
              },
            }),
            fastify.prisma.qcResult.count({ where }),
          ])

          // Map Prisma results to CouchDB-like format for compatibility
          results = qcResults.map((r: any) => ({
            _id: r.id,
            type: 'qc_result',
            testCode: {
              coding: [{ code: r.testCodeLoinc }],
            },
            testName: r.testCatalog?.name,
            instrumentId: r.instrumentId,
            instrumentName: r.instrument?.name,
            materialLot: r.qcMaterialLot,
            targetValue: r.targetValue,
            acceptableRangeLow: r.acceptableRangeLow,
            acceptableRangeHigh: r.acceptableRangeHigh,
            measuredValue: r.actualValue,
            result: r.actualValue,
            unitUcum: r.unitUcum,
            qcRuleViolations: r.qcRuleViolations || [],
            status: r.status,
            runDate: r.runAt.toISOString(),
            runNumber: r.id.substring(0, 8),
            performerId: r.performerId,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          }))
          total = count
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL query failed, falling back to CouchDB')
          // Fall through to CouchDB query
        }
      }

      // Fallback to CouchDB if PostgreSQL not available or failed
      if (results.length === 0 && total === 0) {
        const selector: any = { type: 'qc_result' }

        if (testCode) selector['testCode.coding.code'] = testCode
        if (instrumentId) selector.instrumentId = instrumentId

        const result = await db.find({
          selector,
          limit: parseInt(limit, 10),
          skip: parseInt(skip, 10),
          sort: [{ runDate: 'desc' }],
        })

        results = result.docs
        total = result.docs.length
      }

      const response = { results, count: results.length, total }
      
      // Cache for 2 minutes (QC results change frequently)
      await cache.set(cacheKey, response, 120)

      fastify.log.info({ count: results.length }, 'qc_results.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'qc_results.list_failed')
      reply.code(500).send({ error: 'Failed to list QC results' })
    }
  })

  // GET /qc-results/:id - Get single QC result (with caching)
  fastify.get('/qc-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      // Try cache first
      const cacheKey = `qc-results:${id}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'qc_results.get_cache_hit')
        return reply.send(cached)
      }

      // Try PostgreSQL first, fallback to CouchDB
      let doc: any = null

      if (fastify.prisma) {
        try {
          const qcResult = await fastify.prisma.qcResult.findUnique({
            where: { id },
            include: {
              instrument: true,
              testCatalog: true,
              performer: true,
            },
          })

          if (qcResult) {
            // Map to CouchDB-like format
            doc = {
              _id: qcResult.id,
              type: 'qc_result',
              testCode: {
                coding: [{ code: qcResult.testCodeLoinc }],
              },
              testName: qcResult.testCatalog?.name,
              instrumentId: qcResult.instrumentId,
              instrumentName: qcResult.instrument?.name,
              materialLot: qcResult.qcMaterialLot,
              targetValue: qcResult.targetValue,
              acceptableRangeLow: qcResult.acceptableRangeLow,
              acceptableRangeHigh: qcResult.acceptableRangeHigh,
              measuredValue: qcResult.actualValue,
              result: qcResult.actualValue,
              unitUcum: qcResult.unitUcum,
              qcRuleViolations: qcResult.qcRuleViolations || [],
              status: qcResult.status,
              runDate: qcResult.runAt.toISOString(),
              runNumber: qcResult.id.substring(0, 8),
              performerId: qcResult.performerId,
              createdAt: qcResult.createdAt.toISOString(),
              updatedAt: qcResult.updatedAt.toISOString(),
            }
          }
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL query failed, falling back to CouchDB')
        }
      }

      // Fallback to CouchDB
      if (!doc) {
        doc = await db.get(id)
        if ((doc as any).type !== 'qc_result') {
          reply.code(404).send({ error: 'QC result not found' })
          return
        }
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, doc, 300)

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
      
      // Generate ID if not provided
      const qcResultId = qcResult._id || `qc_result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      const newQCResult = {
        ...qcResult,
        _id: qcResultId,
        type: 'qc_result',
        runDate: qcResult.runDate || now,
        runAt: qcResult.runAt || qcResult.runDate || now,
        actualValue: qcResult.result || qcResult.actualValue || qcResult.measuredValue,
        measuredValue: qcResult.result || qcResult.actualValue || qcResult.measuredValue,
        materialLot: qcResult.materialLot || qcResult.materialId,
        qcRuleViolations: westgardViolations,
        status: qcResult.status || qcStatus,
        createdAt: now,
        updatedAt: now,
      }

      // Use dual-write if available, otherwise fallback to CouchDB only
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.writeQCResult(newQCResult, {
            failOnCouchDB: false, // Don't fail if CouchDB fails
            failOnPostgres: true, // Fail if PostgreSQL fails
          })

          if (!dualWriteResult.overall) {
            fastify.log.error(
              { 
                postgres: dualWriteResult.postgres.error,
                couch: dualWriteResult.couch.error 
              },
              'Dual-write failed, falling back to CouchDB only'
            )
            // Fallback to CouchDB only
            const fallbackResult = await db.insert(newQCResult)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || qcResultId,
              rev: dualWriteResult.couch.rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.error({ error: dualWriteError }, 'Dual-write error, falling back to CouchDB only')
          // Fallback to CouchDB only
          const fallbackResult = await db.insert(newQCResult)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // CouchDB only
        const couchResult = await db.insert(newQCResult)
        result = { id: couchResult.id, rev: couchResult.rev }
      }

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

      // Invalidate cache
      await cache.deletePattern('qc-results:*')

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

