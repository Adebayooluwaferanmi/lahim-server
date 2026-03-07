import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'test_pricing')
    await ensureCouchDBDatabase(fastify, 'cost_accounting')
    await ensureCouchDBDatabase(fastify, 'revenue_tracking')
  }

  // Register stub endpoints if CouchDB is not available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Financial service: CouchDB not available - registering stub endpoints')
    
    fastify.get('/financial/pricing', async (_request, reply) => {
      reply.send({ pricing: [], count: 0 })
    })
    
    fastify.post('/financial/pricing', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/financial/costs', async (_request, reply) => {
      reply.send({ costs: [], count: 0 })
    })
    
    fastify.post('/financial/costs', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/financial/revenue', async (_request, reply) => {
      reply.send({ revenue: [], count: 0, totalRevenue: 0 })
    })
    
    fastify.post('/financial/revenue', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/financial/profitability', async (_request, reply) => {
      reply.send({ totalRevenue: 0, totalCost: 0, profit: 0, margin: '0.00' })
    })
    
    next()
    return
  }

  const pricingDb = fastify.couch.db.use('test_pricing')
  const costDb = fastify.couch.db.use('cost_accounting')
  const revenueDb = fastify.couch.db.use('revenue_tracking')
  const cache = createMetricsCacheHelper(fastify, 'financial')

  // Create indexes
  createCouchDBIndexes(
    fastify,
    'test_pricing',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'testCode'] }, name: 'type-testCode-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
    ],
    'Test Pricing'
  )

  createCouchDBIndexes(
    fastify,
    'cost_accounting',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'testCode'] }, name: 'type-testCode-index' },
      { index: { fields: ['type', 'date'] }, name: 'type-date-index' },
    ],
    'Cost Accounting'
  )

  createCouchDBIndexes(
    fastify,
    'revenue_tracking',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'testCode'] }, name: 'type-testCode-index' },
      { index: { fields: ['type', 'date'] }, name: 'type-date-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
    ],
    'Revenue Tracking'
  )

  // ========== TEST PRICING ==========

  // GET /financial/pricing - Get test pricing
  fastify.get('/financial/pricing', async (request, reply) => {
    try {
      const { testCode, active } = request.query as any
      
      const cacheKey = `financial:pricing:${testCode || 'all'}:${active || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'testPricing' }
      if (testCode) selector.testCode = testCode
      if (active !== undefined) selector.active = active === 'true'

      const result = await pricingDb.find({
        selector,
        limit: 1000,
        sort: [{ testCode: 'asc' }],
      })

      const response = { pricing: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300) // Cache for 5 minutes

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.pricing.list_failed')
      reply.code(500).send({ error: 'Failed to get test pricing' })
    }
  })

  // POST /financial/pricing - Create/update test pricing
  fastify.post('/financial/pricing', async (request, reply) => {
    try {
      const pricing = request.body as any

      if (!pricing.testCode || !pricing.basePrice) {
        reply.code(400).send({ error: 'Test code and base price are required' })
        return
      }

      const now = new Date().toISOString()
      
      // Check if pricing already exists
      const existing = await pricingDb.find({
        selector: { type: 'testPricing', testCode: pricing.testCode },
        limit: 1,
      })

      let result: any
      if (existing.docs.length > 0) {
        // Update existing
        const updated = {
          ...existing.docs[0],
          ...pricing,
          updatedAt: now,
        }
        result = await pricingDb.insert(updated)
      } else {
        // Create new
        const newPricing = {
          ...pricing,
          type: 'testPricing',
          active: pricing.active !== undefined ? pricing.active : true,
          createdAt: now,
          updatedAt: now,
        }
        result = await pricingDb.insert(newPricing)
      }

      await cache.deletePattern('financial:pricing:*')

      fastify.log.info({ testCode: pricing.testCode }, 'financial.pricing.updated')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.pricing.create_failed')
      reply.code(500).send({ error: 'Failed to create test pricing' })
    }
  })

  // ========== COST ACCOUNTING ==========

  // GET /financial/costs - Get cost accounting data
  fastify.get('/financial/costs', async (request, reply) => {
    try {
      const { testCode, startDate, endDate } = request.query as any
      
      const cacheKey = `financial:costs:${testCode || 'all'}:${startDate || 'all'}:${endDate || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'costEntry' }
      if (testCode) selector.testCode = testCode
      if (startDate || endDate) {
        selector.date = {}
        if (startDate) selector.date.$gte = startDate
        if (endDate) selector.date.$lte = endDate
      }

      const result = await costDb.find({
        selector,
        limit: 1000,
        sort: [{ date: 'desc' }],
      })

      const response = { costs: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.costs.list_failed')
      reply.code(500).send({ error: 'Failed to get cost accounting data' })
    }
  })

  // POST /financial/costs - Record cost
  fastify.post('/financial/costs', async (request, reply) => {
    try {
      const cost = request.body as any

      if (!cost.testCode || cost.reagentCost === undefined || cost.laborCost === undefined) {
        reply.code(400).send({ error: 'Test code, reagent cost, and labor cost are required' })
        return
      }

      const now = new Date().toISOString()
      const totalCost = (cost.reagentCost || 0) + (cost.laborCost || 0) + (cost.overheadCost || 0)

      const newCost = {
        ...cost,
        type: 'costEntry',
        totalCost,
        date: cost.date || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await costDb.insert(newCost)
      await cache.deletePattern('financial:costs:*')

      fastify.log.info({ testCode: cost.testCode }, 'financial.cost.recorded')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.cost.create_failed')
      reply.code(500).send({ error: 'Failed to record cost' })
    }
  })

  // ========== REVENUE TRACKING ==========

  // GET /financial/revenue - Get revenue data
  fastify.get('/financial/revenue', async (request, reply) => {
    try {
      const { testCode, patientId, startDate, endDate } = request.query as any
      
      const cacheKey = `financial:revenue:${testCode || 'all'}:${patientId || 'all'}:${startDate || 'all'}:${endDate || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'revenueEntry' }
      if (testCode) selector.testCode = testCode
      if (patientId) selector.patientId = patientId
      if (startDate || endDate) {
        selector.date = {}
        if (startDate) selector.date.$gte = startDate
        if (endDate) selector.date.$lte = endDate
      }

      const result = await revenueDb.find({
        selector,
        limit: 1000,
        sort: [{ date: 'desc' }],
      })

      // Calculate totals
      const totalRevenue = result.docs.reduce((sum: number, doc: any) => sum + (doc.amount || 0), 0)

      const response = {
        revenue: result.docs,
        count: result.docs.length,
        totalRevenue,
      }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.revenue.list_failed')
      reply.code(500).send({ error: 'Failed to get revenue data' })
    }
  })

  // POST /financial/revenue - Record revenue
  fastify.post('/financial/revenue', async (request, reply) => {
    try {
      const revenue = request.body as any

      if (!revenue.testCode || !revenue.amount || !revenue.patientId) {
        reply.code(400).send({ error: 'Test code, amount, and patient ID are required' })
        return
      }

      const now = new Date().toISOString()

      const newRevenue = {
        ...revenue,
        type: 'revenueEntry',
        date: revenue.date || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await revenueDb.insert(newRevenue)
      await cache.deletePattern('financial:revenue:*')

      fastify.log.info({ testCode: revenue.testCode, amount: revenue.amount }, 'financial.revenue.recorded')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.revenue.create_failed')
      reply.code(500).send({ error: 'Failed to record revenue' })
    }
  })

  // GET /financial/profitability - Calculate profitability
  fastify.get('/financial/profitability', async (request, reply) => {
    try {
      const { testCode, startDate, endDate } = request.query as any
      
      const cacheKey = `financial:profitability:${testCode || 'all'}:${startDate || 'all'}:${endDate || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      // Get revenue
      const revenueSelector: any = { type: 'revenueEntry' }
      if (testCode) revenueSelector.testCode = testCode
      if (startDate || endDate) {
        revenueSelector.date = {}
        if (startDate) revenueSelector.date.$gte = startDate
        if (endDate) revenueSelector.date.$lte = endDate
      }

      const revenueResult = await revenueDb.find({ selector: revenueSelector, limit: 10000 })
      const totalRevenue = revenueResult.docs.reduce((sum: number, doc: any) => sum + (doc.amount || 0), 0)

      // Get costs
      const costSelector: any = { type: 'costEntry' }
      if (testCode) costSelector.testCode = testCode
      if (startDate || endDate) {
        costSelector.date = {}
        if (startDate) costSelector.date.$gte = startDate
        if (endDate) costSelector.date.$lte = endDate
      }

      const costResult = await costDb.find({ selector: costSelector, limit: 10000 })
      const totalCost = costResult.docs.reduce((sum: number, doc: any) => sum + (doc.totalCost || 0), 0)

      const profit = totalRevenue - totalCost
      const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0

      const response = {
        totalRevenue,
        totalCost,
        profit,
        margin: margin.toFixed(2),
        testCode: testCode || 'all',
        period: { startDate, endDate },
      }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'financial.profitability.calculate_failed')
      reply.code(500).send({ error: 'Failed to calculate profitability' })
    }
  })

  next()
}

