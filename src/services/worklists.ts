import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'
import { eventBus } from '../lib/event-bus'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { WorklistDualWriteHelper } from '../lib/dual-write-helpers/worklist-dual-write'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: any) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('worklists')
    : null
  const labOrdersDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('lab_orders')
    : null
  const specimensDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('specimens')
    : null
  const cache = createMetricsCacheHelper(fastify, 'worklists')
  
  // Initialize dual-write helper if both databases are available
  const dualWrite = fastify.prisma && fastify.couchAvailable && fastify.couch
    ? new WorklistDualWriteHelper(
        fastify,
        fastify.couch.db.use('worklists'),
        fastify.prisma
      )
    : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'worklists',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'date'] }, name: 'type-date-index' },
      { index: { fields: ['type', 'createdAt'] }, name: 'type-createdAt-index' },
      { index: { fields: ['type', 'date', 'createdAt'] }, name: 'type-date-createdAt-index' },
      { index: { fields: ['date'] }, name: 'date-index' },
      { index: { fields: ['createdAt'] }, name: 'createdAt-index' },
    ],
    'Worklists'
  )

  // GET /worklists - List worklists
  fastify.get('/worklists', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, date } = request.query as any
      
      // Create cache key
      const cacheKey = `worklists:${status || 'all'}:${date || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'worklists.list_cache_hit')
        return reply.send(cached)
      }

      // Try PostgreSQL first (if available), fallback to CouchDB
      let worklists: any[] = []
      let total = 0

      if (fastify.prisma) {
        try {
          const where: any = {}
          if (status) where.status = status
          if (date) {
            // Filter by generatedAt date (date is YYYY-MM-DD format)
            const startDate = new Date(`${date}T00:00:00Z`)
            const endDate = new Date(`${date}T23:59:59Z`)
            where.generatedAt = {
              gte: startDate,
              lte: endDate,
            }
          }

          const [pgWorklists, count] = await Promise.all([
            fastify.prisma.worklist.findMany({
              where,
              take: parseInt(limit, 10),
              skip: parseInt(skip, 10),
              orderBy: { generatedAt: 'desc' },
              include: {
                items: {
                  include: {
                    order: {
                      include: {
                        patient: true,
                        testCatalog: true,
                        testPanel: true,
                      },
                    },
                    testCatalog: true,
                    assignedPractitioner: true,
                  },
                },
                instrument: true,
              },
            }),
            fastify.prisma.worklist.count({ where }),
          ])

          // Map Prisma results to CouchDB-like format for compatibility
          worklists = pgWorklists.map((worklist: any) => {
            const couchWorklist: any = {
              _id: worklist.id,
              _rev: '1-xxx', // Placeholder for CouchDB revision
              type: 'worklist',
              date: worklist.generatedAt.toISOString().split('T')[0],
              mode: 'auto', // Default mode
              instrumentId: worklist.instrumentId,
              status: worklist.status,
              section: worklist.section,
              priority: worklist.priority,
              createdAt: worklist.createdAt?.toISOString(),
              updatedAt: worklist.updatedAt?.toISOString(),
              generatedAt: worklist.generatedAt?.toISOString(),
              completedAt: worklist.completedAt?.toISOString(),
            }

            // Map worklist items to orders and specimens arrays
            const orderMap = new Map()
            const testCodesSet = new Set<string>()

            worklist.items.forEach((item: any) => {
              if (item.order) {
                const orderId = item.order.id
                if (!orderMap.has(orderId)) {
                  orderMap.set(orderId, {
                    orderId: orderId,
                    patientId: item.order.patientId,
                    tests: [],
                  })
                }
                const orderEntry = orderMap.get(orderId)
                
                // Add test code
                if (item.testCatalog) {
                  orderEntry.tests.push({
                    testCode: {
                      coding: [{ code: item.testCatalog.code, display: item.testCatalog.name }],
                    },
                    testName: item.testCatalog.name,
                  })
                  testCodesSet.add(item.testCatalog.code)
                }
              }
            })

            couchWorklist.orders = Array.from(orderMap.values())
            couchWorklist.testCodes = Array.from(testCodesSet)
            couchWorklist.specimens = [] // Specimens would need to be fetched separately if needed

            return couchWorklist
          })
          total = count
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL Worklists query failed, falling back to CouchDB')
          // Fall through to CouchDB query
        }
      }

      // Fallback to CouchDB if PostgreSQL not available or failed
      if (worklists.length === 0 && total === 0 && db) {
      const selector: any = { type: 'worklist' }

      if (status) selector.status = status
      if (date) selector.date = date

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
          sort: [{ date: 'desc' }, { createdAt: 'desc' }],
        })

        worklists = result.docs
        total = result.docs.length
      }

      const response = { worklists, count: worklists.length, total, limit: parseInt(limit, 10), skip: parseInt(skip, 10) }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: worklists.length }, 'worklists.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'worklists.list_failed')
      reply.code(500).send({ error: 'Failed to list worklists' })
    }
  })

  // GET /worklists/:id - Get single worklist
  fastify.get('/worklists/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      // Create cache key
      const cacheKey = `worklist:${id}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'worklists.get_cache_hit')
        return reply.send(cached)
      }

      let worklist: any = null

      // Try PostgreSQL first (if available)
      if (fastify.prisma) {
        try {
          const pgWorklist = await fastify.prisma.worklist.findUnique({
            where: { id },
            include: {
              items: {
                include: {
                  order: {
                    include: {
                      patient: true,
                      testCatalog: true,
                      testPanel: true,
                      specimens: true,
                    },
                  },
                  testCatalog: true,
                  assignedPractitioner: true,
                },
              },
              instrument: true,
            },
          })

          if (pgWorklist) {
            // Map Prisma result to CouchDB-like format
            worklist = {
              _id: pgWorklist.id,
              _rev: '1-xxx',
              type: 'worklist',
              date: pgWorklist.generatedAt.toISOString().split('T')[0],
              mode: 'auto',
              instrumentId: pgWorklist.instrumentId,
              status: pgWorklist.status,
              section: pgWorklist.section,
              priority: pgWorklist.priority,
              createdAt: pgWorklist.createdAt?.toISOString(),
              updatedAt: pgWorklist.updatedAt?.toISOString(),
              generatedAt: pgWorklist.generatedAt?.toISOString(),
              completedAt: pgWorklist.completedAt?.toISOString(),
            }

            // Map worklist items to orders and specimens arrays
            const orderMap = new Map()
            const testCodesSet = new Set<string>()

            pgWorklist.items.forEach((item: any) => {
              if (item.order) {
                const orderId = item.order.id
                if (!orderMap.has(orderId)) {
                  orderMap.set(orderId, {
                    orderId: orderId,
                    patientId: item.order.patientId,
                    tests: [],
                  })
                }
                const orderEntry = orderMap.get(orderId)
                
                if (item.testCatalog) {
                  orderEntry.tests.push({
                    testCode: {
                      coding: [{ code: item.testCatalog.code, display: item.testCatalog.name }],
                    },
                    testName: item.testCatalog.name,
                  })
                  testCodesSet.add(item.testCatalog.code)
                }
              }
            })

            worklist.orders = Array.from(orderMap.values())
            worklist.testCodes = Array.from(testCodesSet)
            
            // Map specimens from orders
            const specimens: any[] = []
            pgWorklist.items.forEach((item: any) => {
              if (item.order?.specimens) {
                item.order.specimens.forEach((specimen: any) => {
                  specimens.push({
                    specimenId: specimen.id,
                    orderId: specimen.orderId,
                    specimenType: {
                      coding: [{ code: specimen.specimenTypeCode }],
                    },
                  })
                })
              }
            })
            worklist.specimens = specimens
          }
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL Worklist query failed, falling back to CouchDB')
        }
      }

      // Fallback to CouchDB if PostgreSQL not available or failed
      if (!worklist && db) {
        try {
      const doc = await db.get(id)
          if ((doc as any).type === 'worklist') {
            worklist = doc
          }
        } catch (couchError: any) {
          if (couchError?.status !== 404) {
            fastify.log.warn({ error: couchError }, 'CouchDB Worklist query failed')
          }
        }
      }

      if (!worklist) {
        reply.code(404).send({ error: 'Worklist not found' })
        return
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, worklist, 300)

      fastify.log.debug({ id }, 'worklists.get')
      reply.send(worklist)
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
    if (!db || !labOrdersDb || !specimensDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
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
      
      // Generate ID if not provided
      const worklistId = `worklist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      const newWorklist: any = {
        _id: worklistId,
        type: 'worklist',
        date: targetDate,
        mode: mode || 'auto',
        instrumentId,
        section: 'General', // Default section, could be derived from testCodes
        testCodes: testCodes || [],
        orders: matchingOrders.map((o: any) => ({
          orderId: o._id,
          patientId: o.patientId,
          tests: o.tests || [],
        })),
        specimens: specimensResult.docs.map((s: any) => ({
          specimenId: s._id,
          orderId: s.orderId,
          specimenType: s.specimenType,
        })),
        status: 'pending',
        generatedAt: now,
        createdAt: now,
        updatedAt: now,
      }

      // Use dual-write if available, otherwise fallback to CouchDB only
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          const dualWriteResult = await dualWrite.writeWorklist(newWorklist, {
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
            const fallbackResult = await db.insert(newWorklist)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || worklistId,
              rev: dualWriteResult.couch.rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.error({ error: dualWriteError }, 'Dual-write error, falling back to CouchDB only')
          // Fallback to CouchDB only
          const fallbackResult = await db.insert(newWorklist)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // CouchDB only
        const couchResult = await db.insert(newWorklist)
        result = { id: couchResult.id, rev: couchResult.rev }
      }

      // Invalidate cache
      await cache.deletePattern('worklists:*')

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'worklist.generated',
            result.id,
            'worklist',
            newWorklist,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish worklist generated event')
      }

      fastify.log.info({ id: result.id, date: targetDate, orderCount: matchingOrders.length }, 'worklists.generated')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newWorklist })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'worklists.generate_failed')
      reply.code(500).send({ error: 'Failed to generate worklist' })
    }
  })

  next()
}

