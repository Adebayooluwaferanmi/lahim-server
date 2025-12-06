import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('test_catalog')
    : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'test_catalog',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'code'] }, name: 'type-code-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
      { index: { fields: ['type', 'department'] }, name: 'type-department-index' },
    ],
    'Test catalog'
  )

  // GET /test-catalog - List all test catalog entries
  fastify.get('/test-catalog', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, active, department, code } = request.query as any
      const selector: any = { type: 'testCatalogEntry' }

      if (active !== undefined) {
        selector.active = active === 'true'
      }
      if (department) {
        selector.department = department
      }
      if (code) {
        selector.code = code
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ code: 'asc' }],
      })

      fastify.log.info({ count: result.docs.length, limit, skip }, 'test_catalog.list')
      
      // If code is specified, return single entry, otherwise return list
      if (code && result.docs.length > 0) {
        reply.send(result.docs[0])
      } else {
        reply.send({ entries: result.docs, count: result.docs.length })
      }
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'test_catalog.list_failed')
      reply.code(500).send({ error: 'Failed to list test catalog entries' })
    }
  })

  // GET /test-catalog/:id - Get single test catalog entry
  fastify.get('/test-catalog/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'testCatalogEntry') {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }

      fastify.log.debug({ id }, 'test_catalog.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'test_catalog.get_failed')
      reply.code(500).send({ error: 'Failed to get test catalog entry' })
    }
  })

  // POST /test-catalog - Create new test catalog entry
  fastify.post('/test-catalog', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const entry = request.body as any

      if (!entry.code || !entry.name) {
        reply.code(400).send({ error: 'Code and name are required' })
        return
      }

      // Check for duplicate code
      const existing = await db.find({
        selector: { type: 'testCatalogEntry', code: entry.code },
        limit: 1,
      })

      if (existing.docs.length > 0) {
        reply.code(409).send({ error: 'Test code already exists' })
        return
      }

      const now = new Date().toISOString()
      const newEntry = {
        ...entry,
        type: 'testCatalogEntry',
        active: entry.active !== undefined ? entry.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newEntry)

      fastify.log.info({ id: result.id, code: entry.code }, 'test_catalog.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newEntry })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'test_catalog.create_failed')
      reply.code(500).send({ error: 'Failed to create test catalog entry' })
    }
  })

  // PUT /test-catalog/:id - Update test catalog entry
  fastify.put('/test-catalog/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'testCatalogEntry') {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }

      // If code is being changed, check for duplicates
      if (updates.code && updates.code !== existing.code) {
        const duplicate = await db.find({
          selector: { type: 'testCatalogEntry', code: updates.code },
          limit: 1,
        })

        if (duplicate.docs.length > 0 && duplicate.docs[0]._id !== id) {
          reply.code(409).send({ error: 'Test code already exists' })
          return
        }
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      fastify.log.info({ id }, 'test_catalog.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'test_catalog.update_failed')
      reply.code(500).send({ error: 'Failed to update test catalog entry' })
    }
  })

  // DELETE /test-catalog/:id - Soft delete (set active: false)
  fastify.delete('/test-catalog/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const existing = await db.get(id) as any

      if (existing.type !== 'testCatalogEntry') {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }

      const updated = {
        ...existing,
        active: false,
        updatedAt: new Date().toISOString(),
      }

      await db.insert(updated)

      fastify.log.info({ id }, 'test_catalog.deleted')
      reply.send({ id, message: 'Test catalog entry deactivated' })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test catalog entry not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'test_catalog.delete_failed')
      reply.code(500).send({ error: 'Failed to delete test catalog entry' })
    }
  })

  next()
}

