import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const organismsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('vocabularies_organisms')
    : null
  const antibioticsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('vocabularies_antibiotics')
    : null
  const valueSetsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('vocabularies_value_sets')
    : null
  const cache = fastify.redis ? new CacheHelper(fastify.redis) : null

  // Create indexes on service load
  if (fastify.couchAvailable && fastify.couch) {
    createCouchDBIndexes(
      fastify,
      'vocabularies_organisms',
      [
        { index: { fields: ['type', 'display'] }, name: 'type-display-index' },
        { index: { fields: ['type', 'code'] }, name: 'type-code-index' },
      ],
      'Vocabularies (organisms)'
    )
    createCouchDBIndexes(
      fastify,
      'vocabularies_antibiotics',
      [
        { index: { fields: ['type', 'display'] }, name: 'type-display-index' },
        { index: { fields: ['type', 'code'] }, name: 'type-code-index' },
      ],
      'Vocabularies (antibiotics)'
    )
    createCouchDBIndexes(
      fastify,
      'vocabularies_value_sets',
      [
        { index: { fields: ['type', 'listId'] }, name: 'type-listId-index' },
      ],
      'Vocabularies (value sets)'
    )
  }

  // ========== ORGANISMS ==========

  // GET /vocabularies/organisms - List organisms
  fastify.get('/vocabularies/organisms', async (request, reply) => {
    if (!organismsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, search, codeSystem } = request.query as any
      
      // Create cache key (vocabularies change infrequently, cache for 1 hour)
      const cacheKey = `vocabularies:organisms:${search || 'all'}:${codeSystem || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'vocabularies.organisms.list_cache_hit')
          return reply.send(cached)
        }
      }
      
      const selector: any = { type: 'organism' }

      if (search) {
        selector.$or = [
          { display: { $regex: `(?i)${search}` } },
          { code: { $regex: `(?i)${search}` } },
        ]
      }
      if (codeSystem) selector.codeSystem = codeSystem

      const result = await organismsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ display: 'asc' }],
      })

      const response = { organisms: result.docs, count: result.docs.length }
      
      // Cache for 1 hour (vocabularies change infrequently)
      if (cache) {
        await cache.set(cacheKey, response, 60 * 60)
      }

      fastify.log.info({ count: result.docs.length }, 'vocabularies.organisms.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.organisms.list_failed')
      reply.code(500).send({ error: 'Failed to list organisms' })
    }
  })

  // GET /vocabularies/organisms/:id - Get single organism
  fastify.get('/vocabularies/organisms/:id', async (request, reply) => {
    if (!organismsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await organismsDb.get(id)

      if ((doc as any).type !== 'organism') {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }

      fastify.log.debug({ id }, 'vocabularies.organisms.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.organisms.get_failed')
      reply.code(500).send({ error: 'Failed to get organism' })
    }
  })

  // POST /vocabularies/organisms - Create organism
  fastify.post('/vocabularies/organisms', async (request, reply) => {
    if (!organismsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const organism = request.body as any

      if (!organism.code || !organism.display) {
        reply.code(400).send({ error: 'Code and display are required' })
        return
      }

      const now = new Date().toISOString()
      const newOrganism = {
        ...organism,
        type: 'organism',
        codeSystem: organism.codeSystem || 'SNOMED-CT',
        active: organism.active !== undefined ? organism.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await organismsDb.insert(newOrganism)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:organisms:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.organism.created' as any,
          result.id,
          'vocabulary-organism',
          newOrganism
        )
      )

      fastify.log.info({ id: result.id, code: organism.code }, 'vocabularies.organisms.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newOrganism })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.organisms.create_failed')
      reply.code(500).send({ error: 'Failed to create organism' })
    }
  })

  // PUT /vocabularies/organisms/:id - Update organism
  fastify.put('/vocabularies/organisms/:id', async (request, reply) => {
    if (!organismsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await organismsDb.get(id) as any

      if (existing.type !== 'organism') {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await organismsDb.insert(updated)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:organisms:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.organism.updated' as any,
          result.id,
          'vocabulary-organism',
          updated
        )
      )

      fastify.log.info({ id }, 'vocabularies.organisms.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.organisms.update_failed')
      reply.code(500).send({ error: 'Failed to update organism' })
    }
  })

  // DELETE /vocabularies/organisms/:id - Delete organism
  fastify.delete('/vocabularies/organisms/:id', async (request, reply) => {
    if (!organismsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await organismsDb.get(id)

      if ((doc as any).type !== 'organism') {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }

      await organismsDb.destroy(id, (doc as any)._rev)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:organisms:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.organism.deleted' as any,
          id,
          'vocabulary-organism',
          { id }
        )
      )

      fastify.log.info({ id }, 'vocabularies.organisms.deleted')
      reply.send({ id, deleted: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Organism not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.organisms.delete_failed')
      reply.code(500).send({ error: 'Failed to delete organism' })
    }
  })

  // ========== ANTIBIOTICS ==========

  // GET /vocabularies/antibiotics - List antibiotics
  fastify.get('/vocabularies/antibiotics', async (request, reply) => {
    if (!antibioticsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, search, codeSystem } = request.query as any
      
      // Create cache key
      const cacheKey = `vocabularies:antibiotics:${search || 'all'}:${codeSystem || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'vocabularies.antibiotics.list_cache_hit')
          return reply.send(cached)
        }
      }
      
      const selector: any = { type: 'antibiotic' }

      if (search) {
        selector.$or = [
          { display: { $regex: `(?i)${search}` } },
          { code: { $regex: `(?i)${search}` } },
        ]
      }
      if (codeSystem) selector.codeSystem = codeSystem

      const result = await antibioticsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ display: 'asc' }],
      })

      const response = { antibiotics: result.docs, count: result.docs.length }
      
      // Cache for 1 hour
      if (cache) {
        await cache.set(cacheKey, response, 60 * 60)
      }

      fastify.log.info({ count: result.docs.length }, 'vocabularies.antibiotics.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.antibiotics.list_failed')
      reply.code(500).send({ error: 'Failed to list antibiotics' })
    }
  })

  // GET /vocabularies/antibiotics/:id - Get single antibiotic
  fastify.get('/vocabularies/antibiotics/:id', async (request, reply) => {
    if (!antibioticsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await antibioticsDb.get(id)

      if ((doc as any).type !== 'antibiotic') {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }

      fastify.log.debug({ id }, 'vocabularies.antibiotics.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.antibiotics.get_failed')
      reply.code(500).send({ error: 'Failed to get antibiotic' })
    }
  })

  // POST /vocabularies/antibiotics - Create antibiotic
  fastify.post('/vocabularies/antibiotics', async (request, reply) => {
    if (!antibioticsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const antibiotic = request.body as any

      if (!antibiotic.code || !antibiotic.display) {
        reply.code(400).send({ error: 'Code and display are required' })
        return
      }

      const now = new Date().toISOString()
      const newAntibiotic = {
        ...antibiotic,
        type: 'antibiotic',
        codeSystem: antibiotic.codeSystem || 'ATC',
        active: antibiotic.active !== undefined ? antibiotic.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await antibioticsDb.insert(newAntibiotic)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:antibiotics:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.antibiotic.created' as any,
          result.id,
          'vocabulary-antibiotic',
          newAntibiotic
        )
      )

      fastify.log.info({ id: result.id, code: antibiotic.code }, 'vocabularies.antibiotics.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newAntibiotic })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.antibiotics.create_failed')
      reply.code(500).send({ error: 'Failed to create antibiotic' })
    }
  })

  // PUT /vocabularies/antibiotics/:id - Update antibiotic
  fastify.put('/vocabularies/antibiotics/:id', async (request, reply) => {
    if (!antibioticsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await antibioticsDb.get(id) as any

      if (existing.type !== 'antibiotic') {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await antibioticsDb.insert(updated)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:antibiotics:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.antibiotic.updated' as any,
          result.id,
          'vocabulary-antibiotic',
          updated
        )
      )

      fastify.log.info({ id }, 'vocabularies.antibiotics.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.antibiotics.update_failed')
      reply.code(500).send({ error: 'Failed to update antibiotic' })
    }
  })

  // DELETE /vocabularies/antibiotics/:id - Delete antibiotic
  fastify.delete('/vocabularies/antibiotics/:id', async (request, reply) => {
    if (!antibioticsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await antibioticsDb.get(id)

      if ((doc as any).type !== 'antibiotic') {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }

      await antibioticsDb.destroy(id, (doc as any)._rev)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:antibiotics:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.antibiotic.deleted' as any,
          id,
          'vocabulary-antibiotic',
          { id }
        )
      )

      fastify.log.info({ id }, 'vocabularies.antibiotics.deleted')
      reply.send({ id, deleted: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Antibiotic not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.antibiotics.delete_failed')
      reply.code(500).send({ error: 'Failed to delete antibiotic' })
    }
  })

  // ========== VALUE SETS ==========

  // GET /vocabularies/value-sets - List value sets
  fastify.get('/vocabularies/value-sets', async (request, reply) => {
    if (!valueSetsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, listId } = request.query as any
      
      // Create cache key
      const cacheKey = `vocabularies:value-sets:${listId || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'vocabularies.value_sets.list_cache_hit')
          return reply.send(cached)
        }
      }
      
      const selector: any = { type: 'value_set' }

      if (listId) selector.listId = listId

      const result = await valueSetsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ listId: 'asc' }, { display: 'asc' }],
      })

      const response = { valueSets: result.docs, count: result.docs.length }
      
      // Cache for 1 hour
      if (cache) {
        await cache.set(cacheKey, response, 60 * 60)
      }

      fastify.log.info({ count: result.docs.length }, 'vocabularies.value_sets.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.value_sets.list_failed')
      reply.code(500).send({ error: 'Failed to list value sets' })
    }
  })

  // GET /vocabularies/value-sets/:listId - Get value set by list ID
  fastify.get('/vocabularies/value-sets/:listId', async (request, reply) => {
    if (!valueSetsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { listId } = request.params as { listId: string }
      const result = await valueSetsDb.find({
        selector: {
          type: 'value_set',
          listId,
          active: true,
        },
        sort: [{ display: 'asc' }],
      })

      fastify.log.debug({ listId, count: result.docs.length }, 'vocabularies.value_sets.get')
      reply.send({ listId, items: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error, listId: (request.params as any).listId }, 'vocabularies.value_sets.get_failed')
      reply.code(500).send({ error: 'Failed to get value set' })
    }
  })

  // POST /vocabularies/value-sets - Create value set item
  fastify.post('/vocabularies/value-sets', async (request, reply) => {
    if (!valueSetsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const valueSet = request.body as any

      if (!valueSet.listId || !valueSet.code || !valueSet.display) {
        reply.code(400).send({ error: 'List ID, code, and display are required' })
        return
      }

      const now = new Date().toISOString()
      const newValueSet = {
        ...valueSet,
        type: 'value_set',
        active: valueSet.active !== undefined ? valueSet.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await valueSetsDb.insert(newValueSet)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:value-sets:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.value_set.created' as any,
          result.id,
          'vocabulary-value-set',
          newValueSet
        )
      )

      fastify.log.info({ id: result.id, listId: valueSet.listId, code: valueSet.code }, 'vocabularies.value_sets.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newValueSet })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'vocabularies.value_sets.create_failed')
      reply.code(500).send({ error: 'Failed to create value set item' })
    }
  })

  // PUT /vocabularies/value-sets/:id - Update value set item
  fastify.put('/vocabularies/value-sets/:id', async (request, reply) => {
    if (!valueSetsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await valueSetsDb.get(id) as any

      if (existing.type !== 'value_set') {
        reply.code(404).send({ error: 'Value set item not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await valueSetsDb.insert(updated)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:value-sets:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.value_set.updated' as any,
          result.id,
          'vocabulary-value-set',
          updated
        )
      )

      fastify.log.info({ id }, 'vocabularies.value_sets.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Value set item not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.value_sets.update_failed')
      reply.code(500).send({ error: 'Failed to update value set item' })
    }
  })

  // DELETE /vocabularies/value-sets/:id - Delete value set item
  fastify.delete('/vocabularies/value-sets/:id', async (request, reply) => {
    if (!valueSetsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await valueSetsDb.get(id)

      if ((doc as any).type !== 'value_set') {
        reply.code(404).send({ error: 'Value set item not found' })
        return
      }

      await valueSetsDb.destroy(id, (doc as any)._rev)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('vocabularies:value-sets:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'vocabulary.value_set.deleted' as any,
          id,
          'vocabulary-value-set',
          { id }
        )
      )

      fastify.log.info({ id }, 'vocabularies.value_sets.deleted')
      reply.send({ id, deleted: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Value set item not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'vocabularies.value_sets.delete_failed')
      reply.code(500).send({ error: 'Failed to delete value set item' })
    }
  })

  next()
}

