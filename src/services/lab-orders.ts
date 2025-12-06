import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('lab_orders')

  // GET /lab-orders - List lab orders
  fastify.get('/lab-orders', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId } = request.query as any
      const selector: any = { type: 'lab_order' }

      if (status) selector.status = status
      if (patientId) selector.patientId = patientId

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ orderedOn: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'lab_orders.list')
      reply.send({ orders: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_orders.list_failed')
      reply.code(500).send({ error: 'Failed to list lab orders' })
    }
  })

  // GET /lab-orders/:id - Get single lab order
  fastify.get('/lab-orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      fastify.log.debug({ id }, 'lab_orders.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_orders.get_failed')
      reply.code(500).send({ error: 'Failed to get lab order' })
    }
  })

  // POST /lab-orders - Create lab order
  fastify.post('/lab-orders', async (request, reply) => {
    try {
      const order = request.body as any

      if (!order.patientId || !order.tests || order.tests.length === 0) {
        reply.code(400).send({ error: 'Patient ID and at least one test are required' })
        return
      }

      const now = new Date().toISOString()
      const newOrder = {
        ...order,
        type: 'lab_order',
        status: order.status || 'ordered',
        orderedOn: order.orderedOn || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newOrder)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'lab.order.created',
            result.id,
            'lab-order',
            newOrder,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab order created event')
      }

      fastify.log.info({ id: result.id, patientId: order.patientId }, 'lab_orders.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newOrder })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_orders.create_failed')
      reply.code(500).send({ error: 'Failed to create lab order' })
    }
  })

  // PUT /lab-orders/:id - Update lab order
  fastify.put('/lab-orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'lab.order.updated',
            id,
            'lab-order',
            updated,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab order updated event')
      }

      fastify.log.info({ id }, 'lab_orders.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_orders.update_failed')
      reply.code(500).send({ error: 'Failed to update lab order' })
    }
  })

  next()
}

