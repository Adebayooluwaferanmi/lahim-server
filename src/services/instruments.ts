import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { createCouchDBIndexes } from '../lib/db-utils'
import { createInstrumentDualWriteHelper } from '../lib/dual-write-helpers/instrument-dual-write'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('instruments')
    : null
  const cache = createMetricsCacheHelper(fastify, 'instruments')
  const dualWrite = fastify.prisma ? createInstrumentDualWriteHelper(fastify) : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'instruments',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Instruments'
  )

  // GET /instruments - List instruments (with caching)
  fastify.get('/instruments', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, status } = request.query as any
      
      // Create cache key
      const cacheKey = `instruments:${status || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'instruments.list_cache_hit')
        return reply.send(cached)
      }

      const selector: any = { type: 'instrument' }

      if (status) selector.status = status

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      const response = { instruments: result.docs, count: result.docs.length }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: result.docs.length }, 'instruments.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'instruments.list_failed')
      reply.code(500).send({ error: 'Failed to list instruments' })
    }
  })

  // GET /instruments/:id - Get single instrument (with caching)
  fastify.get('/instruments/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      
      // Try cache first
      const cacheKey = `instruments:${id}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'instruments.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'instrument') {
        reply.code(404).send({ error: 'Instrument not found' })
        return
      }

      // Cache for 10 minutes
      await cache.set(cacheKey, doc, 600)

      fastify.log.debug({ id }, 'instruments.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Instrument not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'instruments.get_failed')
      reply.code(500).send({ error: 'Failed to get instrument' })
    }
  })

  // POST /instruments - Create instrument
  fastify.post('/instruments', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const instrument = request.body as any

      if (!instrument.name || !instrument.type) {
        reply.code(400).send({ error: 'Name and type are required' })
        return
      }

      const now = new Date().toISOString()
      const newInstrument = {
        ...instrument,
        type: 'instrument',
        status: instrument.status || 'offline',
        createdAt: now,
        updatedAt: now,
      }

      // Use dual-write if available, otherwise fallback to CouchDB only
      let result: { id: string; rev: string }
      if (dualWrite && fastify.prisma) {
        try {
          // Generate ID if not provided
          if (!newInstrument._id) {
            newInstrument._id = `instrument_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          }

          const dualWriteResult = await dualWrite.writeInstrument(newInstrument, {
            failOnCouchDB: false,
            failOnPostgres: true,
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
            const fallbackResult = await db.insert(newInstrument)
            result = { id: fallbackResult.id, rev: fallbackResult.rev }
          } else {
            result = {
              id: dualWriteResult.postgres.id || dualWriteResult.couch.id || newInstrument._id,
              rev: dualWriteResult.couch.rev || '',
            }
          }
        } catch (dualWriteError) {
          fastify.log.warn({ error: dualWriteError }, 'Dual-write error, falling back to CouchDB only')
          const fallbackResult = await db.insert(newInstrument)
          result = { id: fallbackResult.id, rev: fallbackResult.rev }
        }
      } else {
        // No dual-write available, use CouchDB only
        const insertResult = await db.insert(newInstrument)
        result = { id: insertResult.id, rev: insertResult.rev }
      }

      // Invalidate cache
      await cache.deletePattern('instruments:*')

      fastify.log.info({ id: result.id, name: instrument.name }, 'instruments.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newInstrument })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'instruments.create_failed')
      reply.code(500).send({ error: 'Failed to create instrument' })
    }
  })

  // PUT /instruments/:id - Update instrument
  fastify.put('/instruments/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'instrument') {
        reply.code(404).send({ error: 'Instrument not found' })
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
          const dualWriteResult = await dualWrite.updateInstrument(id, updates, {
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
      await cache.deletePattern('instruments:*')
      await cache.delete(`instruments:${id}`)

      fastify.log.info({ id }, 'instruments.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Instrument not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'instruments.update_failed')
      reply.code(500).send({ error: 'Failed to update instrument' })
    }
  })

  // POST /instruments/:id/import-results - Import results from instrument
  fastify.post('/instruments/:id/import-results', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const { results, format } = request.body as { results: any[]; format?: string }

      const instrument = await db.get(id) as any
      if (instrument.type !== 'instrument') {
        reply.code(404).send({ error: 'Instrument not found' })
        return
      }

      if (instrument.status !== 'online') {
        reply.code(400).send({ error: 'Instrument is not online' })
        return
      }

      // Simulate processing and importing results
      const importedCount = results.length
      const processedResults: any[] = []

      for (const rawResult of results) {
        // In a real implementation, this would involve:
        // 1. Parsing instrument data format (HL7, ASTM, custom JSON, etc.)
        // 2. Mapping to lab result format (using test catalog for guidance)
        // 3. Validating results against rules (e.g., reference ranges, critical values)
        // 4. Creating lab result records in the 'lab_results' database
        // 5. Linking to existing lab orders and specimens

        fastify.log.debug({ instrumentId: id, rawResult, format }, 'Processing raw instrument result')
        processedResults.push({
          status: 'processed',
          originalData: rawResult,
          mappedData: { /* ... mapped lab result structure ... */ },
        })
      }

      fastify.log.info({ instrumentId: id, resultCount: importedCount, format }, 'instrument.results.imported')
      reply.send({
        imported: importedCount,
        message: `Results import initiated for ${importedCount} items (simplified implementation).`,
        processedResults,
      })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Instrument not found' })
        return
      }
      fastify.log.error(error as Error, 'instrument.import_failed')
      reply.code(500).send({ error: 'Failed to import instrument results' })
    }
  })

  next()
}

