import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'settings')
    await ensureCouchDBDatabase(fastify, 'departments')
    await ensureCouchDBDatabase(fastify, 'locations')
  }

  // Only create database references if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Settings service: CouchDB not available - endpoints will return errors')
    return
  }

  const settingsDb = fastify.couch.db.use('settings')
  const departmentsDb = fastify.couch.db.use('departments')
  const locationsDb = fastify.couch.db.use('locations')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'departments',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Settings (departments)'
  )
  createCouchDBIndexes(
    fastify,
    'locations',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Settings (locations)'
  )

  // ========== SETTINGS ==========
  
  // GET /settings - Get system settings
  fastify.get('/settings', async (_request, reply) => {
    try {
      const result = await settingsDb.find({
        selector: { type: 'system_setting' },
        limit: 1000,
      })
      reply.send({ settings: result.docs })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'settings.get_failed')
      reply.code(500).send({ error: 'Failed to get settings' })
    }
  })

  // PUT /settings - Update system settings
  fastify.put('/settings', async (request, reply) => {
    try {
      const settings = request.body as any
      const now = new Date().toISOString()
      
      const updatedSettings = {
        ...settings,
        type: 'system_setting',
        updatedAt: now,
      }

      const result = await settingsDb.insert(updatedSettings)
      reply.send({ id: result.id, rev: result.rev, ...updatedSettings })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'settings.update_failed')
      reply.code(500).send({ error: 'Failed to update settings' })
    }
  })

  // ========== DEPARTMENTS ==========

  // GET /departments - List departments
  fastify.get('/departments', async (_request, reply) => {
    try {
      const result = await departmentsDb.find({
        selector: { type: 'department' },
        sort: [{ name: 'asc' }],
      })
      reply.send({ departments: result.docs })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'departments.list_failed')
      reply.code(500).send({ error: 'Failed to list departments' })
    }
  })

  // POST /departments - Create department
  fastify.post('/departments', async (request, reply) => {
    try {
      const dept = request.body as any
      if (!dept.name) {
        reply.code(400).send({ error: 'Department name is required' })
        return
      }

      const now = new Date().toISOString()
      const newDept = {
        ...dept,
        type: 'department',
        createdAt: now,
        updatedAt: now,
      }

      const result = await departmentsDb.insert(newDept)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newDept })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'departments.create_failed')
      reply.code(500).send({ error: 'Failed to create department' })
    }
  })

  // PUT /departments/:id - Update department
  fastify.put('/departments/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await departmentsDb.get(id)
      if ((existing as any).type !== 'department') {
        reply.code(404).send({ error: 'Department not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: new Date().toISOString(),
      }

      const result = await departmentsDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Department not found' })
        return
      }
      fastify.log.error(error as Error, 'departments.update_failed')
      reply.code(500).send({ error: 'Failed to update department' })
    }
  })

  // DELETE /departments/:id - Delete department
  fastify.delete('/departments/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const existing = await departmentsDb.get(id)
      await departmentsDb.destroy(id, (existing as any)._rev)
      reply.send({ message: 'Department deleted' })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Department not found' })
        return
      }
      fastify.log.error(error as Error, 'departments.delete_failed')
      reply.code(500).send({ error: 'Failed to delete department' })
    }
  })

  // ========== LOCATIONS ==========

  // GET /locations - List locations
  fastify.get('/locations', async (_request, reply) => {
    try {
      const result = await locationsDb.find({
        selector: { type: 'location' },
        sort: [{ name: 'asc' }],
      })
      reply.send({ locations: result.docs })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'locations.list_failed')
      reply.code(500).send({ error: 'Failed to list locations' })
    }
  })

  // POST /locations - Create location
  fastify.post('/locations', async (request, reply) => {
    try {
      const location = request.body as any
      if (!location.name) {
        reply.code(400).send({ error: 'Location name is required' })
        return
      }

      const now = new Date().toISOString()
      const newLocation = {
        ...location,
        type: 'location',
        createdAt: now,
        updatedAt: now,
      }

      const result = await locationsDb.insert(newLocation)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newLocation })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'locations.create_failed')
      reply.code(500).send({ error: 'Failed to create location' })
    }
  })

  // PUT /locations/:id - Update location
  fastify.put('/locations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await locationsDb.get(id)
      if ((existing as any).type !== 'location') {
        reply.code(404).send({ error: 'Location not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: new Date().toISOString(),
      }

      const result = await locationsDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Location not found' })
        return
      }
      fastify.log.error(error as Error, 'locations.update_failed')
      reply.code(500).send({ error: 'Failed to update location' })
    }
  })

  // DELETE /locations/:id - Delete location
  fastify.delete('/locations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const existing = await locationsDb.get(id)
      await locationsDb.destroy(id, (existing as any)._rev)
      reply.send({ message: 'Location deleted' })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Location not found' })
        return
      }
      fastify.log.error(error as Error, 'locations.delete_failed')
      reply.code(500).send({ error: 'Failed to delete location' })
    }
  })

}

