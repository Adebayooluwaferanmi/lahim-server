import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { nextCallback } from 'fastify-plugin'

const checkQCRequirement = async (
  fastify: FastifyInstance,
  testCode: string,
  instrumentId?: string,
): Promise<{ required: boolean; reason?: string }> => {
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
  next: nextCallback,
) => {
  const db = fastify.couch.db.use('qc_results')

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

      const now = new Date().toISOString()
      const newQCResult = {
        ...qcResult,
        type: 'qc_result',
        runDate: qcResult.runDate || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newQCResult)

      fastify.log.info({ id: result.id, testCode: testCodeValue }, 'qc_results.created')
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

