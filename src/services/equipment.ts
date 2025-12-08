/**
 * Equipment Service
 * Manages laboratory equipment registration, maintenance, and lifecycle tracking
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'
import { createCouchDBIndexes } from '../lib/db-utils'
import { createEquipmentDualWriteHelper } from '../lib/dual-write-helpers/equipment-dual-write'
import { CouchEquipment, CouchEquipmentMaintenance } from '../lib/mappers/equipment-mapper'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('equipment')
    : null
  const cache = fastify.redis ? new CacheHelper(fastify.redis) : null
  const dualWrite = fastify.prisma ? createEquipmentDualWriteHelper(fastify) : null

  // Create indexes on service load
  if (fastify.couchAvailable && fastify.couch) {
    createCouchDBIndexes(
      fastify,
      'equipment',
      [
        { index: { fields: ['type'] }, name: 'type-index' },
        { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
        { index: { fields: ['type', 'location'] }, name: 'type-location-index' },
        { index: { fields: ['type', 'equipmentType'] }, name: 'type-equipmentType-index' },
        { index: { fields: ['type', 'serialNumber'] }, name: 'type-serialNumber-index' },
      ],
      'Equipment'
    ).catch((err) => {
      fastify.log.warn({ error: err }, 'Failed to create equipment indexes on startup')
    })
  }

  // POST /equipment - Register equipment
  fastify.post('/equipment', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const equipmentData = request.body as any

      if (!equipmentData.name || !equipmentData.equipmentType) {
        reply.code(400).send({ error: 'Name and equipment type are required' })
        return
      }

      const now = new Date().toISOString()
      const newEquipment: CouchEquipment = {
        _id: `equipment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'equipment',
        name: equipmentData.name,
        equipmentType: equipmentData.equipmentType,
        manufacturer: equipmentData.manufacturer,
        model: equipmentData.model,
        serialNumber: equipmentData.serialNumber,
        location: equipmentData.location,
        status: equipmentData.status || 'active',
        purchaseDate: equipmentData.purchaseDate,
        warrantyExpiry: equipmentData.warrantyExpiry,
        lastMaintenance: equipmentData.lastMaintenance,
        nextMaintenance: equipmentData.nextMaintenance,
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.writeEquipment(newEquipment)
      } else {
        const result = await db.insert(newEquipment)
        newEquipment._id = result.id
        newEquipment._rev = result.rev
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'equipment.registered' as any,
          newEquipment._id,
          'equipment',
          newEquipment
        )
      )

      fastify.log.info({ id: newEquipment._id, name: equipmentData.name }, 'equipment.registered')
      reply.code(201).send({ id: newEquipment._id, rev: newEquipment._rev, ...newEquipment })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'equipment.create_failed')
      reply.code(500).send({ error: 'Failed to register equipment' })
    }
  })

  // GET /equipment - List equipment
  fastify.get('/equipment', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, status, equipmentType, location } = request.query as any

      // Create cache key
      const cacheKey = `equipment:list:${status || 'all'}:${equipmentType || 'all'}:${location || 'all'}:${limit}:${skip}`

      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'equipment.list_cache_hit')
          return reply.send(cached)
        }
      }

      const selector: any = { type: 'equipment' }

      if (status) selector.status = status
      if (equipmentType) selector.equipmentType = equipmentType
      if (location) selector.location = location

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      const response = { equipment: result.docs, count: result.docs.length }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 5)
      }

      fastify.log.info({ count: result.docs.length }, 'equipment.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'equipment.list_failed')
      reply.code(500).send({ error: 'Failed to list equipment' })
    }
  })

  // GET /equipment/:id - Get single equipment
  fastify.get('/equipment/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }

      // Try cache first
      const cacheKey = `equipment:${id}`
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ id }, 'equipment.get_cache_hit')
          return reply.send(cached)
        }
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, doc, 60 * 5)
      }

      fastify.log.debug({ id }, 'equipment.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.get_failed')
      reply.code(500).send({ error: 'Failed to get equipment' })
    }
  })

  // PUT /equipment/:id - Update equipment
  fastify.put('/equipment/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.updateEquipment(id, updated)
      } else {
        await db.insert(updated)
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'equipment.updated' as any,
          id,
          'equipment',
          updated
        )
      )

      fastify.log.info({ id }, 'equipment.updated')
      reply.send(updated)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.update_failed')
      reply.code(500).send({ error: 'Failed to update equipment' })
    }
  })

  // POST /equipment/:id/maintenance - Schedule maintenance
  fastify.post('/equipment/:id/maintenance', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const maintenanceData = request.body as any

      if (!maintenanceData.maintenanceType || !maintenanceData.scheduledAt) {
        reply.code(400).send({ error: 'Maintenance type and scheduled date are required' })
        return
      }

      // Verify equipment exists
      const equipment = await db.get(id) as any
      if (equipment.type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

      const now = new Date().toISOString()
      const newMaintenance: CouchEquipmentMaintenance = {
        _id: `maintenance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'equipment_maintenance',
        equipmentId: id,
        maintenanceType: maintenanceData.maintenanceType,
        scheduledAt: maintenanceData.scheduledAt,
        performedAt: maintenanceData.performedAt,
        performedBy: maintenanceData.performedBy,
        cost: maintenanceData.cost,
        notes: maintenanceData.notes,
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.writeMaintenance(newMaintenance)
      } else {
        await db.insert(newMaintenance)
      }

      // Update equipment's nextMaintenance if this is scheduled
      if (maintenanceData.maintenanceType === 'preventive' && maintenanceData.scheduledAt) {
        const equipmentUpdate = {
          ...equipment,
          nextMaintenance: maintenanceData.scheduledAt,
          updatedAt: now,
        }
        if (dualWrite) {
          await dualWrite.updateEquipment(id, equipmentUpdate)
        } else {
          await db.insert(equipmentUpdate)
        }
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'equipment.maintenance.scheduled' as any,
          id,
          'equipment',
          { maintenanceId: newMaintenance._id, ...maintenanceData }
        )
      )

      fastify.log.info({ id, maintenanceId: newMaintenance._id }, 'equipment.maintenance.scheduled')
      reply.code(201).send({ id: newMaintenance._id, rev: newMaintenance._rev, ...newMaintenance })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.maintenance.create_failed')
      reply.code(500).send({ error: 'Failed to schedule maintenance' })
    }
  })

  // GET /equipment/:id/history - Get maintenance history
  fastify.get('/equipment/:id/history', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }

      // Verify equipment exists
      await db.get(id)

      // Try cache first
      const cacheKey = `equipment:${id}:history`
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ id }, 'equipment.history_cache_hit')
          return reply.send(cached)
        }
      }

      const result = await db.find({
        selector: {
          type: 'equipment_maintenance',
          equipmentId: id,
        },
        sort: [{ scheduledAt: 'desc' }],
      })

      const response = { history: result.docs, count: result.docs.length }

      // Cache for 2 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 2)
      }

      fastify.log.debug({ id, count: result.docs.length }, 'equipment.history')
      reply.send(response)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.history_failed')
      reply.code(500).send({ error: 'Failed to get maintenance history' })
    }
  })

  // POST /equipment/:id/calibrate - Record calibration
  fastify.post('/equipment/:id/calibrate', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const calibrationData = request.body as any

      // Verify equipment exists
      const equipment = await db.get(id) as any
      if (equipment.type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

      const now = new Date().toISOString()
      const calibration: CouchEquipmentMaintenance = {
        _id: `calibration_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'equipment_maintenance',
        equipmentId: id,
        maintenanceType: 'calibration',
        scheduledAt: calibrationData.scheduledAt || now,
        performedAt: calibrationData.performedAt || now,
        performedBy: calibrationData.performedBy,
        cost: calibrationData.cost,
        notes: calibrationData.notes,
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.writeMaintenance(calibration)
      } else {
        await db.insert(calibration)
      }

      // Update equipment's lastMaintenance
      const equipmentUpdate = {
        ...equipment,
        lastMaintenance: calibration.performedAt || now,
        updatedAt: now,
      }
      if (dualWrite) {
        await dualWrite.updateEquipment(id, equipmentUpdate)
      } else {
        await db.insert(equipmentUpdate)
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'equipment.maintenance.completed' as any,
          id,
          'equipment',
          { maintenanceId: calibration._id, type: 'calibration' }
        )
      )

      fastify.log.info({ id, calibrationId: calibration._id }, 'equipment.calibrated')
      reply.code(201).send({ id: calibration._id, rev: calibration._rev, ...calibration })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.calibrate_failed')
      reply.code(500).send({ error: 'Failed to record calibration' })
    }
  })

  next()
}

