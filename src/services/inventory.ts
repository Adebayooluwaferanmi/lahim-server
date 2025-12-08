import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus, EventType } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('inventory')
    : null
  const cache = fastify.redis ? new CacheHelper(fastify.redis) : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'inventory',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'itemName'] }, name: 'type-itemName-index' },
      { index: { fields: ['type', 'itemCode'] }, name: 'type-itemCode-index' },
      { index: { fields: ['type', 'category'] }, name: 'type-category-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Inventory'
  )

  // GET /inventory/items - List inventory items
  fastify.get('/inventory/items', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, search, category, lowStock } = request.query as any
      
      // Create cache key
      const cacheKey = `inventory:items:${search || 'all'}:${category || 'all'}:${lowStock || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'inventory.items.list_cache_hit')
          return reply.send(cached)
        }
      }
      
      const selector: any = { type: 'inventory_item' }

      if (search) {
        selector.$or = [
          { itemName: { $regex: `(?i)${search}` } },
          { itemCode: { $regex: `(?i)${search}` } },
          { manufacturer: { $regex: `(?i)${search}` } },
        ]
      }
      if (category) selector.category = category
      if (lowStock === 'true') {
        selector.$expr = { $lt: ['$quantityOnHand', '$reorderLevel'] }
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ itemName: 'asc' }],
      })

      const response = { items: result.docs, count: result.docs.length }
      
      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 5)
      }

      fastify.log.info({ count: result.docs.length }, 'inventory.items.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'inventory.items.list_failed')
      reply.code(500).send({ error: 'Failed to list inventory items' })
    }
  })

  // GET /inventory/items/:id - Get single inventory item
  fastify.get('/inventory/items/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      
      // Try cache first
      const cacheKey = `inventory:item:${id}`
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ id }, 'inventory.items.get_cache_hit')
          return reply.send(cached)
        }
      }
      
      const doc = await db.get(id)

      if ((doc as any).type !== 'inventory_item') {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, doc, 60 * 5)
      }

      fastify.log.debug({ id }, 'inventory.items.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'inventory.items.get_failed')
      reply.code(500).send({ error: 'Failed to get inventory item' })
    }
  })

  // POST /inventory/items - Create inventory item
  fastify.post('/inventory/items', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const item = request.body as any

      if (!item.name || !item.category) {
        reply.code(400).send({ error: 'Name and category are required' })
        return
      }

      const now = new Date().toISOString()
      const newItem = {
        ...item,
        type: 'inventory_item',
        quantityOnHand: item.quantityOnHand || 0,
        reorderLevel: item.reorderLevel || 0,
        reorderQuantity: item.reorderQuantity || 0,
        unit: item.unit || 'each',
        status: item.status || 'active',
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newItem)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('inventory:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'inventory.item.created',
          result.id,
          'inventory-item',
          newItem
        )
      )

      fastify.log.info({ id: result.id, name: item.name }, 'inventory.items.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newItem })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'inventory.items.create_failed')
      reply.code(500).send({ error: 'Failed to create inventory item' })
    }
  })

  // PUT /inventory/items/:id - Update inventory item
  fastify.put('/inventory/items/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'inventory_item') {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('inventory:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'inventory.item.updated',
          result.id,
          'inventory-item',
          updated
        )
      )

      fastify.log.info({ id }, 'inventory.items.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'inventory.items.update_failed')
      reply.code(500).send({ error: 'Failed to update inventory item' })
    }
  })

  // DELETE /inventory/items/:id - Delete inventory item
  fastify.delete('/inventory/items/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'inventory_item') {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }

      await db.destroy(id, (doc as any)._rev)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('inventory:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'inventory.item.deleted',
          id,
          'inventory-item',
          { id }
        )
      )

      fastify.log.info({ id }, 'inventory.items.deleted')
      reply.send({ id, deleted: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'inventory.items.delete_failed')
      reply.code(500).send({ error: 'Failed to delete inventory item' })
    }
  })

  // POST /inventory/receive - Receive inventory
  fastify.post('/inventory/receive', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { itemId, quantity, lotNumber, expirationDate, receivedBy, notes } = request.body as any

      if (!itemId || !quantity || !receivedBy) {
        reply.code(400).send({ error: 'Item ID, quantity, and received by are required' })
        return
      }

      const item = await db.get(itemId) as any
      if (item.type !== 'inventory_item') {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }

      const now = new Date().toISOString()
      const transaction: any = {
        type: 'inventory_transaction',
        itemId,
        transactionType: 'receive',
        quantity: parseFloat(quantity),
        lotNumber,
        expirationDate,
        receivedBy,
        notes,
        transactionDate: now,
        createdAt: now,
      }

      await db.insert(transaction)

      // Update item quantity
      const updatedItem = {
        ...item,
        quantityOnHand: (item.quantityOnHand || 0) + parseFloat(quantity),
        updatedAt: now,
      }

      const result = await db.insert(updatedItem)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('inventory:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'inventory.received',
          itemId,
          'inventory-transaction',
          {
            itemId,
            quantity: parseFloat(quantity),
            lotNumber,
            expirationDate,
            receivedBy,
            transactionId: transaction._id || transaction.id,
          }
        )
      )

      fastify.log.info({ itemId, quantity, receivedBy }, 'inventory.received')
      reply.code(201).send({ id: result.id, rev: result.rev, ...updatedItem })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }
      fastify.log.error(error as Error, 'inventory.receive_failed')
      reply.code(500).send({ error: 'Failed to receive inventory' })
    }
  })

  // POST /inventory/issue - Issue inventory
  fastify.post('/inventory/issue', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { itemId, quantity, issuedTo, notes } = request.body as any

      if (!itemId || !quantity || !issuedTo) {
        reply.code(400).send({ error: 'Item ID, quantity, and issued to are required' })
        return
      }

      const item = await db.get(itemId) as any
      if (item.type !== 'inventory_item') {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }

      if ((item.quantityOnHand || 0) < parseFloat(quantity)) {
        reply.code(400).send({ error: 'Insufficient quantity on hand' })
        return
      }

      const now = new Date().toISOString()
      const transaction: any = {
        type: 'inventory_transaction',
        itemId,
        transactionType: 'issue',
        quantity: parseFloat(quantity),
        issuedTo,
        notes,
        transactionDate: now,
        createdAt: now,
      }

      await db.insert(transaction)

      // Update item quantity
      const updatedItem = {
        ...item,
        quantityOnHand: (item.quantityOnHand || 0) - parseFloat(quantity),
        updatedAt: now,
      }

      const result = await db.insert(updatedItem)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('inventory:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'inventory.issued',
          itemId,
          'inventory-transaction',
          {
            itemId,
            quantity: parseFloat(quantity),
            issuedTo,
            transactionId: transaction._id || transaction.id,
          }
        )
      )

      fastify.log.info({ itemId, quantity, issuedTo }, 'inventory.issued')
      reply.code(201).send({ id: result.id, rev: result.rev, ...updatedItem })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Inventory item not found' })
        return
      }
      fastify.log.error(error as Error, 'inventory.issue_failed')
      reply.code(500).send({ error: 'Failed to issue inventory' })
    }
  })

  // GET /inventory/stock-levels - Get stock levels
  fastify.get('/inventory/stock-levels', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { category, lowStock } = request.query as any
      
      // Create cache key
      const cacheKey = `inventory:stock-levels:${category || 'all'}:${lowStock || 'all'}`
      
      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'inventory.stock_levels.list_cache_hit')
          return reply.send(cached)
        }
      }
      
      const selector: any = { type: 'inventory_item' }

      if (category) selector.category = category
      if (lowStock === 'true') {
        selector.$expr = { $lt: ['$quantityOnHand', '$reorderLevel'] }
      }

      const result = await db.find({
        selector,
        sort: [{ itemName: 'asc' }], // Use itemName instead of name (matches the index)
      })

      const response = { items: result.docs, count: result.docs.length }
      
      // Cache for 2 minutes (stock levels change more frequently)
      if (cache) {
        await cache.set(cacheKey, response, 60 * 2)
      }

      fastify.log.info({ count: result.docs.length }, 'inventory.stock_levels.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'inventory.stock_levels.list_failed')
      reply.code(500).send({ error: 'Failed to get stock levels' })
    }
  })

  next()
}

