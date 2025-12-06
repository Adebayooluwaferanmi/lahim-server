import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('worklists')
  const labOrdersDb = fastify.couch.db.use('lab_orders')
  const specimensDb = fastify.couch.db.use('specimens')

  // GET /worklists - List worklists
  fastify.get('/worklists', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, date } = request.query as any
      const selector: any = { type: 'worklist' }

      if (status) selector.status = status
      if (date) selector.date = date

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ date: 'desc' }, { createdAt: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'worklists.list')
      reply.send({ worklists: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'worklists.list_failed')
      reply.code(500).send({ error: 'Failed to list worklists' })
    }
  })

  // GET /worklists/:id - Get single worklist
  fastify.get('/worklists/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'worklist') {
        reply.code(404).send({ error: 'Worklist not found' })
        return
      }

      fastify.log.debug({ id }, 'worklists.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Worklist not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'worklists.get_failed')
      reply.code(500).send({ error: 'Failed to get worklist' })
    }
  })

  // POST /worklists/generate - Generate worklist
  fastify.post('/worklists/generate', async (request, reply) => {
    try {
      const { date, testCodes, instrumentId, mode } = request.body as any

      const targetDate = date || new Date().toISOString().split('T')[0]

      // Find pending lab orders for the date
      const ordersResult = await labOrdersDb.find({
        selector: {
          type: 'lab_order',
          status: { $in: ['ordered', 'specimen-collected'] },
          orderedOn: { $gte: `${targetDate}T00:00:00Z`, $lte: `${targetDate}T23:59:59Z` },
        },
      })

      // Filter by test codes if provided
      let matchingOrders = ordersResult.docs
      if (testCodes && testCodes.length > 0) {
        matchingOrders = matchingOrders.filter((order: any) =>
          order.tests?.some((test: any) => {
            const testCode = test.testCode?.coding?.[0]?.code || test.testCode
            return testCodes.includes(testCode)
          }),
        )
      }

      // Get associated specimens
      const orderIds = matchingOrders.map((o: any) => o._id)
      const specimensResult = await specimensDb.find({
        selector: {
          type: 'specimen',
          orderId: { $in: orderIds },
          status: { $in: ['collected', 'received', 'processing'] },
        },
      })

      const now = new Date().toISOString()
      const newWorklist: any = {
        type: 'worklist',
        date: targetDate,
        mode: mode || 'auto',
        instrumentId,
        testCodes: testCodes || [],
        orders: matchingOrders.map((o: any) => ({
          orderId: o._id,
          patientId: o.patientId,
          tests: o.tests,
        })),
        specimens: specimensResult.docs.map((s: any) => ({
          specimenId: s._id,
          orderId: s.orderId,
          specimenType: s.specimenType,
        })),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newWorklist)

      fastify.log.info({ id: result.id, date: targetDate, orderCount: matchingOrders.length }, 'worklists.generated')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newWorklist })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'worklists.generate_failed')
      reply.code(500).send({ error: 'Failed to generate worklist' })
    }
  })

  next()
}

