import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { createLabOrderDualWriteHelper } from '../lib/dual-write-helpers/lab-order-dual-write'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('lab_orders')
  const cache = createMetricsCacheHelper(fastify, 'lab-orders')
  const dualWrite = fastify.prisma ? createLabOrderDualWriteHelper(fastify) : null

  // Create indexes on service load (fire and forget, but log errors)
  createCouchDBIndexes(
    fastify,
    'lab_orders',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'orderedOn'] }, name: 'type-orderedOn-index' },
      { index: { fields: ['type', 'status', 'orderedOn'] }, name: 'type-status-orderedOn-index' },
    ],
    'Lab Orders'
  ).catch((err) => {
    fastify.log.warn({ error: err }, 'Failed to create lab-orders indexes on startup')
  })

  // GET /lab-orders - List lab orders
  fastify.get('/lab-orders', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId } = request.query as any
      
      // Create cache key
      const cacheKey = `lab-orders:${status || 'all'}:${patientId || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lab_orders.list_cache_hit')
        return reply.send(cached)
      }

      // Try PostgreSQL first (if available), fallback to CouchDB
      let orders: any[] = []
      let total = 0

      if (fastify.prisma) {
        try {
          const where: any = {}
          if (status) where.status = status
          if (patientId) where.patientId = patientId

          const [labOrders, count] = await Promise.all([
            fastify.prisma.labOrder.findMany({
              where,
              take: parseInt(limit, 10),
              skip: parseInt(skip, 10),
              orderBy: { orderedAt: 'desc' },
              include: {
                patient: true,
                practitioner: true,
                testCatalog: true,
                testPanel: true,
                specimens: true,
                results: true,
              },
            }),
            fastify.prisma.labOrder.count({ where }),
          ])

          // Map Prisma results to CouchDB-like format for compatibility
          orders = labOrders.map((order: any) => {
            const couchOrder: any = {
              _id: order.id,
              _rev: '1-xxx', // Placeholder for CouchDB revision
              type: 'lab_order',
              patientId: order.patientId,
              status: order.status,
              priority: order.priority,
              orderedOn: order.orderedAt?.toISOString(),
              collectedOn: order.collectedAt?.toISOString(),
              receivedOn: order.receivedAt?.toISOString(),
              finalizedOn: order.finalizedAt?.toISOString(),
              facilityId: order.facilityId,
              practitionerId: order.practitionerId,
              createdAt: order.createdAt?.toISOString(),
              updatedAt: order.updatedAt?.toISOString(),
            }

            // Handle panel vs individual test orders
            if (order.isPanel && order.panelId) {
              couchOrder.isPanel = true
              couchOrder.panelId = order.panelId
              couchOrder.testCodeLoinc = undefined
              if (order.testPanel) {
                couchOrder.tests = order.testPanel.parameters?.map((param: any) => ({
                  testCode: {
                    coding: [{ code: param.parameterCode, display: param.parameterName }],
                  },
                  testName: param.parameterName,
                })) || []
              }
            } else {
              couchOrder.isPanel = false
              couchOrder.testCodeLoinc = order.testCodeLoinc
              if (order.testCatalog) {
                couchOrder.tests = [{
                  testCode: {
                    coding: [{ code: order.testCatalog.code, display: order.testCatalog.name }],
                  },
                  testName: order.testCatalog.name,
                }]
              }
            }

            // Add patient info if available
            if (order.patient) {
              couchOrder.patientName = `${order.patient.firstName || ''} ${order.patient.lastName || ''}`.trim()
            }

            // Add practitioner info
            if (order.practitioner) {
              couchOrder.practitionerName = `${order.practitioner.firstName || ''} ${order.practitioner.lastName || ''}`.trim()
            }

            return couchOrder
          })
          total = count
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL Lab Orders query failed, falling back to CouchDB')
          // Fall through to CouchDB query
        }
      }

      // Fallback to CouchDB if PostgreSQL not available or failed
      if (orders.length === 0 && total === 0) {
        const selector: any = { type: 'lab_order' }

        if (status) selector.status = status
        if (patientId) selector.patientId = patientId

        let result
        try {
          result = await db.find({
            selector,
            limit: parseInt(limit, 10),
            skip: parseInt(skip, 10),
            sort: [{ orderedOn: 'desc' }],
          })
        } catch (sortError: any) {
          // If sort fails due to missing index, try to create it and retry
          const errorMessage = sortError?.message || String(sortError)
          if (errorMessage.includes('No index exists for this sort')) {
            fastify.log.warn('Index missing for sort, creating index and retrying...')
            try {
              // Try to create the index
              await createCouchDBIndexes(
                fastify,
                'lab_orders',
                [
                  { index: { fields: ['type', 'orderedOn'] }, name: 'type-orderedOn-index' },
                  { index: { fields: ['type', 'status', 'orderedOn'] }, name: 'type-status-orderedOn-index' },
                ],
                'Lab Orders'
              )
              // Retry the query
              result = await db.find({
                selector,
                limit: parseInt(limit, 10),
                skip: parseInt(skip, 10),
                sort: [{ orderedOn: 'desc' }],
              })
            } catch (retryError) {
              // If retry still fails, try without sort
              fastify.log.warn('Retry with index failed, trying without sort...')
              result = await db.find({
                selector,
                limit: parseInt(limit, 10),
                skip: parseInt(skip, 10),
              })
              // Sort in memory as fallback
              if (result.docs && Array.isArray(result.docs)) {
                result.docs.sort((a: any, b: any) => {
                  const aDate = a.orderedOn ? new Date(a.orderedOn).getTime() : 0
                  const bDate = b.orderedOn ? new Date(b.orderedOn).getTime() : 0
                  return bDate - aDate
                })
              }
            }
          } else {
            throw sortError
          }
        }
        orders = result.docs
        total = result.docs.length
      }

      const response = { orders, count: orders.length, total, limit: parseInt(limit, 10), skip: parseInt(skip, 10) }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: orders.length }, 'lab_orders.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_orders.list_failed')
      reply.code(500).send({ error: 'Failed to list lab orders' })
    }
  })

  // GET /lab-orders/:id - Get single lab order
  fastify.get('/lab-orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      // Create cache key
      const cacheKey = `lab-order:${id}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lab_orders.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, doc, 300)

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

      // Validate panel or individual test order
      if (!order.patientId) {
        reply.code(400).send({ error: 'Patient ID is required' })
        return
      }

      if (order.isPanel) {
        if (!order.panelId) {
          reply.code(400).send({ error: 'Panel ID is required for panel orders' })
          return
        }
      } else {
        if (!order.testCodeLoinc && (!order.tests || order.tests.length === 0)) {
          reply.code(400).send({ error: 'Test code or tests array is required for individual test orders' })
          return
        }
      }

      const now = new Date().toISOString()
      
      // If panel order, expand to individual parameters
      let panelParameters: any[] = []
      if (order.isPanel && order.panelId) {
        try {
          // Get panel from CouchDB or PostgreSQL
          const panelsDb = fastify.couchAvailable && fastify.couch 
            ? fastify.couch.db.use('test_panels')
            : null

          if (panelsDb) {
            const panelDoc = await panelsDb.get(order.panelId)
            if ((panelDoc as any).type === 'testPanel') {
              panelParameters = (panelDoc as any).parameters || []
            }
          } else if (fastify.prisma) {
            const panel = await fastify.prisma.testPanel.findUnique({
              where: { id: order.panelId },
              include: { parameters: { orderBy: { sequence: 'asc' } } },
            })
            if (panel) {
              panelParameters = panel.parameters.map((p: any) => ({
                parameterCode: p.parameterCode,
                parameterName: p.parameterName,
                unit: p.unit,
                refRangeLow: p.refRangeLow,
                refRangeHigh: p.refRangeHigh,
                criticalLow: p.criticalLow,
                criticalHigh: p.criticalHigh,
              }))
            }
          }

          if (panelParameters.length === 0) {
            reply.code(404).send({ error: 'Panel not found or has no parameters' })
            return
          }

          // Expand panel to individual tests for CouchDB structure
          order.tests = panelParameters.map((param: any) => ({
            testCode: param.parameterCode,
            testName: param.parameterName,
          }))
        } catch (panelError) {
          fastify.log.error({ error: panelError }, 'Failed to fetch panel')
          reply.code(404).send({ error: 'Panel not found' })
          return
        }
      }

      const newOrder = {
        ...order,
        type: 'lab_order' as const,
        status: order.status || 'ordered',
        orderedOn: order.orderedOn || now,
        createdAt: now,
        updatedAt: now,
      }

      // Use dual-write if available, otherwise fallback to CouchDB only
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          // Generate ID if not provided
          if (!newOrder._id) {
            newOrder._id = `lab_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          }

          const dualWriteResult = await dualWrite.writeLabOrder(newOrder, {
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
            const fallbackResult = await db.insert(newOrder)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || newOrder._id,
              rev: dualWriteResult.couch.rev || '',
            }

            // If panel order, create result entries for each parameter
            if (order.isPanel && panelParameters.length > 0 && fastify.prisma) {
              try {
                const orderId = result.id
                const resultsDb = fastify.couchAvailable && fastify.couch 
                  ? fastify.couch.db.use('lab_results')
                  : null

                for (const param of panelParameters) {
                  // Create result in PostgreSQL
                  await fastify.prisma.labResult.create({
                    data: {
                      orderId,
                      analyteCodeLoinc: param.parameterCode,
                      resultType: 'numeric', // Default, can be updated later
                      refRangeLow: param.refRangeLow,
                      refRangeHigh: param.refRangeHigh,
                    },
                  })

                  // Create result in CouchDB if available
                  if (resultsDb) {
                    const resultDoc = {
                      _id: `lab_result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      type: 'lab_result',
                      orderId,
                      analyteCodeLoinc: param.parameterCode,
                      parameterName: param.parameterName,
                      resultType: 'numeric',
                      refRangeLow: param.refRangeLow,
                      refRangeHigh: param.refRangeHigh,
                      criticalLow: param.criticalLow,
                      criticalHigh: param.criticalHigh,
                      unit: param.unit,
                      status: 'pending',
                      createdAt: now,
                      updatedAt: now,
                    }
                    resultsDb.insert(resultDoc).catch((err) => {
                      fastify.log.warn({ error: err }, 'Failed to create result in CouchDB')
                    })
                  }
                }
                fastify.log.info({ orderId, parameterCount: panelParameters.length }, 'lab_orders.panel_expanded')
              } catch (resultError) {
                fastify.log.error({ error: resultError }, 'Failed to create panel result entries')
                // Don't fail the order creation if result creation fails
              }
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write error, falling back to CouchDB only')
          const fallbackResult = await db.insert(newOrder)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(newOrder)
        result = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.deletePattern('lab-orders:*')

      // Publish event
      try {
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

      // Use dual-write if available
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.updateLabOrder(id, updates, {
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
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || id,
              rev: dualWriteResult.couch.rev || existing._rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write update error, falling back to CouchDB only')
          const fallbackResult = await db.insert(updated)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(updated)
        result = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.delete(`lab-order:${id}`)
      await cache.deletePattern('lab-orders:*')

      // Publish event - check if status changed to completed
      const eventType = updated.status === 'completed' ? 'lab.order.completed' : 'lab.order.updated'
      try {
        await eventBus.publish(
          eventBus.createEvent(
            eventType,
            id,
            'lab-order',
            updated,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, `Failed to publish ${eventType} event`)
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

