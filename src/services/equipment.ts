/**
 * Equipment Service
 * Manages laboratory equipment registration, maintenance, and lifecycle tracking
 * Enhanced with maintenance plans, document attachments, RBAC/ACL, and audit logging
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { randomUUID } from 'crypto'
import { eventBus } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'
import { createCouchDBIndexes, ensureCouchDBDatabase } from '../lib/db-utils'
import { createEquipmentDualWriteHelper } from '../lib/dual-write-helpers/equipment-dual-write'
import {
  CouchEquipment,
  CouchEquipmentMaintenance,
  MaintenancePlan as StoredMaintenancePlan,
} from '../lib/mappers/equipment-mapper'
import { computeNextDue } from '../lib/equipment/compute-next-due'
import {
  EquipmentCreateUpdateSchema,
  DocumentAttachmentSchema,
  MaintenanceEventSchema,
  EquipmentSearchQuerySchema,
} from '../lib/equipment/equipment-schemas'
import { createEquipmentAuthHook, requireEquipmentRole } from '../lib/rbac/equipment-rbac'
import { EquipmentAuditHelper } from '../lib/audit/equipment-audit'
import { parseISO, addDays } from 'date-fns'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('equipment')
    : null
  const maintenanceDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('equipment')
    : null // Use same DB for maintenance records
  const cache = fastify.redis ? new CacheHelper(fastify.redis) : null
  const dualWrite = fastify.prisma ? createEquipmentDualWriteHelper(fastify) : null

  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    ensureCouchDBDatabase(fastify, 'equipment').catch((err) => {
      fastify.log.warn({ error: err }, 'Failed to ensure equipment database')
    })
  }

  // Create indexes on service load
  if (fastify.couchAvailable && fastify.couch) {
    createCouchDBIndexes(
      fastify,
      'equipment',
      [
        { index: { fields: ['type'] }, name: 'type-index' },
        { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
        { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
        { index: { fields: ['type', 'location'] }, name: 'type-location-index' },
        { index: { fields: ['type', 'equipmentType'] }, name: 'type-equipmentType-index' },
        { index: { fields: ['type', 'serialNumber'] }, name: 'type-serialNumber-index' },
        { index: { fields: ['type', 'vendorId'] }, name: 'type-vendorId-index' },
        { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
        { index: { fields: ['type', 'maintenancePlan.nextDue'] }, name: 'type-nextDue-index' },
        { index: { fields: ['type', 'equipmentId', 'performedAt'] }, name: 'type-equipmentId-performedAt-index' },
      ],
      'Equipment'
    ).catch((err) => {
      fastify.log.warn({ error: err }, 'Failed to create equipment indexes on startup')
    })
  }

  // POST /equipment - Create Equipment
  fastify.post(
    '/equipment',
    {
      preHandler: requireEquipmentRole(['equipment:manager']),
    },
    async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }

      const audit = new EquipmentAuditHelper(fastify, request)

      try {
        // Validate payload
        const validationResult = EquipmentCreateUpdateSchema.safeParse(request.body)
        if (!validationResult.success) {
          reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors.map((e: any) => ({
              field: e.path.join('.'),
              code: e.code,
              message: e.message,
            })),
          })
        return
      }

        const equipmentData = validationResult.data
      const now = new Date().toISOString()
        const id = `equipment:${randomUUID()}`

        // Process maintenance plan if provided
        let maintenancePlan: StoredMaintenancePlan | undefined
        if (equipmentData.maintenancePlan) {
          let plan = { ...equipmentData.maintenancePlan }
          // Normalize kind
          if (plan.kind === 'weekly') {
            plan = { ...plan, intervalValue: 1, intervalUnit: 'weeks' as const }
          } else if (plan.kind === 'monthly') {
            plan = { ...plan, intervalValue: 1, intervalUnit: 'months' as const }
          }

          // Compute nextDue (never accept from client)
          const nextDue = computeNextDue(
            plan.lastDate || null,
            plan.intervalValue,
            plan.intervalUnit
          )
          maintenancePlan = { ...plan, nextDue } as StoredMaintenancePlan
        }

      const newEquipment: CouchEquipment = {
          _id: id,
        type: 'equipment',
        name: equipmentData.name,
          vendorId: equipmentData.vendorId,
          vendorName: equipmentData.vendorName,
          support: equipmentData.support,
          documents: equipmentData.documents || [],
          maintenancePlan,
          acls: equipmentData.acls || [],
          active: true,
          // Legacy fields for backward compatibility
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
        let result: any
      if (dualWrite) {
          result = await dualWrite.writeEquipment(newEquipment)
          newEquipment._rev = result.couch.rev
      } else {
          result = await db.insert(newEquipment)
        newEquipment._id = result.id
        newEquipment._rev = result.rev
      }

        // Audit log
        await audit.logCreate(id, newEquipment)

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
          'equipment.registered' as any,
            id,
          'equipment',
          newEquipment
        )
      )

        fastify.log.info({ id, name: equipmentData.name }, 'equipment.registered')
      reply.code(201).send({ id: newEquipment._id, rev: newEquipment._rev, ...newEquipment })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'equipment.create_failed')
        if ((error as any)?.message?.includes('intervalValue')) {
          reply.code(400).send({ error: (error as Error).message })
        } else {
      reply.code(500).send({ error: 'Failed to register equipment' })
        }
      }
    }
  )

  // GET /equipment - Search/List with Filters
  fastify.get('/equipment', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      // Validate query params
      const queryResult = EquipmentSearchQuerySchema.safeParse(request.query)
      if (!queryResult.success) {
        reply.code(400).send({
          error: 'Invalid query parameters',
          details: queryResult.error.errors,
        })
        return
      }

      const { vendorId, active, dueInDays, text, skip, limit, status, equipmentType, location } = queryResult.data

      // Create cache key
      const cacheKey = `equipment:list:${vendorId || 'all'}:${active !== undefined ? active : 'all'}:${dueInDays || 'all'}:${text || 'all'}:${status || 'all'}:${equipmentType || 'all'}:${location || 'all'}:${limit}:${skip}`

      // Try to get from cache
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
          fastify.log.debug({ cacheKey }, 'equipment.list_cache_hit')
          return reply.send(cached)
        }
      }

      const selector: any = { type: 'equipment' }

      if (vendorId) selector.vendorId = vendorId
      if (active !== undefined) selector.active = active
      if (status) selector.status = status
      if (equipmentType) selector.equipmentType = equipmentType
      if (location) selector.location = location

      // Text search (prefix match on name/model/serial)
      if (text) {
        selector.$or = [
          { name: { $regex: `(?i)^${text}` } },
          { model: { $regex: `(?i)^${text}` } },
          { serialNumber: { $regex: `(?i)^${text}` } },
        ]
      }

      // Due/overdue filter
      if (dueInDays !== undefined) {
        const soonDate = addDays(new Date(), dueInDays).toISOString()
        selector['maintenancePlan.nextDue'] = { $lte: soonDate }
      }

      const result = await db.find({
        selector,
        limit,
        skip,
        // Sort by nextDue asc, NULLS LAST (equipment without maintenance plans go last)
        sort: [
          { 'maintenancePlan.nextDue': 'asc' },
          { name: 'asc' },
        ],
      })

      // Sort manually to handle NULLS LAST (CouchDB doesn't support this natively)
      const sortedDocs = result.docs.sort((a: any, b: any) => {
        const aNextDue = a.maintenancePlan?.nextDue
        const bNextDue = b.maintenancePlan?.nextDue
        if (!aNextDue && !bNextDue) return 0
        if (!aNextDue) return 1 // NULLS LAST
        if (!bNextDue) return -1
        return aNextDue.localeCompare(bNextDue)
      })

      const response = { items: sortedDocs, total: sortedDocs.length }

      // Cache for 5 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 5)
      }

      fastify.log.info({ count: sortedDocs.length }, 'equipment.list')
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

  // PUT /equipment/:id - Update Equipment
  fastify.put(
    '/equipment/:id',
    {
      preHandler: createEquipmentAuthHook(['equipment:manager'], true),
    },
    async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }

      const audit = new EquipmentAuditHelper(fastify, request)

    try {
      const { id } = request.params as { id: string }
        const existing = (request as any).equipment || (await db.get(id))

        if ((existing as any).type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

        // Validate payload
        const validationResult = EquipmentCreateUpdateSchema.partial().safeParse(request.body)
        if (!validationResult.success) {
          reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors.map((e: any) => ({
              field: e.path.join('.'),
              code: e.code,
              message: e.message,
            })),
          })
          return
        }

        const updates = validationResult.data
        const now = new Date().toISOString()

        // Process maintenance plan update
        let maintenancePlan = updates.maintenancePlan
        if (maintenancePlan) {
          // Normalize kind
          if (maintenancePlan.kind === 'weekly') {
            maintenancePlan = { ...maintenancePlan, intervalValue: 1, intervalUnit: 'weeks' as const }
          } else if (maintenancePlan.kind === 'monthly') {
            maintenancePlan = { ...maintenancePlan, intervalValue: 1, intervalUnit: 'months' as const }
          }

          // Compute nextDue if interval changed or lastDate updated
          const existingPlan = (existing as any).maintenancePlan
          if (
            !existingPlan ||
            existingPlan.intervalValue !== maintenancePlan.intervalValue ||
            existingPlan.intervalUnit !== maintenancePlan.intervalUnit ||
            maintenancePlan.lastDate !== existingPlan.lastDate
          ) {
            const nextDue = computeNextDue(
              maintenancePlan.lastDate || existingPlan?.lastDate || null,
              maintenancePlan.intervalValue,
              maintenancePlan.intervalUnit
            )
            maintenancePlan = { ...maintenancePlan, nextDue } as StoredMaintenancePlan
          } else {
            // Preserve existing nextDue if plan unchanged
            maintenancePlan = {
              ...maintenancePlan,
              nextDue: existingPlan.nextDue,
            } as StoredMaintenancePlan
          }
        }

        const updated: CouchEquipment = {
        ...existing,
        ...updates,
          maintenancePlan: maintenancePlan || (existing as any).maintenancePlan,
          updatedAt: now,
      }

      // Dual-write
      if (dualWrite) {
        await dualWrite.updateEquipment(id, updated)
      } else {
        await db.insert(updated)
      }

        // Audit log
        await audit.logUpdate(id, existing, updated)

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
    }
  )

  // POST /equipment/:id/documents - Attach Document
  fastify.post(
    '/equipment/:id/documents',
    {
      preHandler: createEquipmentAuthHook(['equipment:manager'], true),
    },
    async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }

      const audit = new EquipmentAuditHelper(fastify, request)

    try {
      const { id } = request.params as { id: string }
        const equipment = (request as any).equipment || (await db.get(id))

        if ((equipment as any).type !== 'equipment') {
          reply.code(404).send({ error: 'Equipment not found' })
          return
        }

        // Validate document payload
        const validationResult = DocumentAttachmentSchema.safeParse(request.body)
        if (!validationResult.success) {
          reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors.map((e: any) => ({
              field: e.path.join('.'),
              code: e.code,
              message: e.message,
            })),
          })
          return
        }

        const fileMeta = validationResult.data

        // Sanitize fileMeta (remove any dangerous fields)
        const sanitizedDoc = {
          name: fileMeta.name,
          mime: fileMeta.mime,
          size: fileMeta.size,
          storageKey: fileMeta.storageKey,
          uploadedAt: fileMeta.uploadedAt,
          uploadedBy: fileMeta.uploadedBy,
        }

        // Append to documents array
        const documents = (equipment as any).documents || []
        documents.push(sanitizedDoc)

        const updated = {
          ...equipment,
          documents,
          updatedAt: new Date().toISOString(),
        }

        // Save
        if (dualWrite) {
          await dualWrite.updateEquipment(id, updated)
        } else {
          await db.insert(updated)
        }

        // Audit log
        await audit.logAttachDocument(id, sanitizedDoc)

        // Invalidate cache
        if (cache) {
          await cache.deletePattern('equipment:*')
        }

        fastify.log.info({ id, documentName: fileMeta.name }, 'equipment.document.attached')
        reply.send({ documents })
      } catch (error: unknown) {
        if ((error as any)?.status === 404) {
          reply.code(404).send({ error: 'Equipment not found' })
          return
        }
        fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.document.attach_failed')
        reply.code(500).send({ error: 'Failed to attach document' })
      }
    }
  )

  // POST /equipment/:id/maintenance - Log Maintenance Event
  fastify.post(
    '/equipment/:id/maintenance',
    {
      preHandler: createEquipmentAuthHook(['equipment:technician', 'equipment:manager'], true),
    },
    async (request, reply) => {
      if (!db || !maintenanceDb) {
        reply.code(503).send({ error: 'CouchDB is not available' })
        return
      }

      const audit = new EquipmentAuditHelper(fastify, request)

      try {
        const { id } = request.params as { id: string }
        const equipment = (request as any).equipment || (await db.get(id))

        if ((equipment as any).type !== 'equipment') {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }

        // Validate maintenance event payload
        const validationResult = MaintenanceEventSchema.safeParse(request.body)
        if (!validationResult.success) {
          reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors.map((e: any) => ({
              field: e.path.join('.'),
              code: e.code,
              message: e.message,
            })),
          })
          return
        }

        const eventData = validationResult.data
      const now = new Date().toISOString()
        const maintId = `maint:${randomUUID()}`

        // Create maintenance record
      const newMaintenance: CouchEquipmentMaintenance = {
          _id: maintId,
          type: 'maintenance',
        equipmentId: id,
          performedAt: eventData.performedAt,
          performerId: eventData.performerId,
          maintenanceType: eventData.maintenanceType,
          notes: eventData.notes,
          partsUsed: eventData.partsUsed,
          attachments: eventData.attachments,
          planSnapshot: (equipment as any).maintenancePlan ? JSON.parse(JSON.stringify((equipment as any).maintenancePlan)) : undefined,
        createdAt: now,
        updatedAt: now,
      }

        // Save maintenance record
      if (dualWrite) {
        await dualWrite.writeMaintenance(newMaintenance)
      } else {
          await maintenanceDb.insert(newMaintenance)
      }

        // If routine maintenance and maintenance plan exists, update nextDue
        if (eventData.maintenanceType === 'routine' && (equipment as any).maintenancePlan) {
          const plan = (equipment as any).maintenancePlan
          const updatedPlan: StoredMaintenancePlan = {
            ...plan,
            lastDate: eventData.performedAt,
            nextDue: computeNextDue(eventData.performedAt, plan.intervalValue, plan.intervalUnit),
          }

          const updatedEquipment = {
          ...equipment,
            maintenancePlan: updatedPlan,
          updatedAt: now,
        }

        if (dualWrite) {
            await dualWrite.updateEquipment(id, updatedEquipment)
        } else {
            await db.insert(updatedEquipment)
      }

      // Invalidate cache
      if (cache) {
        await cache.deletePattern('equipment:*')
      }
        }

        // Audit log
        await audit.logCreateMaintenance(id, newMaintenance)

      // Publish event
      await eventBus.publish(
        eventBus.createEvent(
            'equipment.maintenance.logged' as any,
          id,
          'equipment',
            { maintenanceId: maintId, ...eventData }
        )
      )

        fastify.log.info({ id, maintenanceId: maintId }, 'equipment.maintenance.logged')
        reply.code(201).send({ id: maintId, rev: (newMaintenance as any)._rev, ...newMaintenance })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.maintenance.create_failed')
        reply.code(500).send({ error: 'Failed to log maintenance event' })
    }
    }
  )

  // GET /equipment/:id/maintenance - List Maintenance History
  fastify.get(
    '/equipment/:id/maintenance',
    {
      preHandler: createEquipmentAuthHook(['equipment:technician', 'equipment:manager'], true),
    },
    async (request, reply) => {
      if (!maintenanceDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }

      // Verify equipment exists
        if (!(request as any).equipment) {
          const db = fastify.couchAvailable && fastify.couch
            ? fastify.couch.db.use('equipment')
            : null
          if (db) {
      await db.get(id)
          }
        }

      // Try cache first
        const cacheKey = `equipment:${id}:maintenance`
      if (cache) {
        const cached = await cache.get(cacheKey)
        if (cached) {
            fastify.log.debug({ id }, 'equipment.maintenance.list_cache_hit')
          return reply.send(cached)
        }
      }

        const result = await maintenanceDb.find({
        selector: {
            $or: [
              { type: 'maintenance', equipmentId: id },
              { type: 'equipment_maintenance', equipmentId: id },
            ],
        },
          sort: [{ performedAt: 'desc' }, { scheduledAt: 'desc' }],
      })

        const response = { items: result.docs, total: result.docs.length }

      // Cache for 2 minutes
      if (cache) {
        await cache.set(cacheKey, response, 60 * 2)
      }

        fastify.log.debug({ id, count: result.docs.length }, 'equipment.maintenance.list')
      reply.send(response)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Equipment not found' })
        return
      }
        fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'equipment.maintenance.list_failed')
      reply.code(500).send({ error: 'Failed to get maintenance history' })
    }
    }
  )

  // GET /maintenance/calendar - Calendar View
  fastify.get(
    '/maintenance/calendar',
    {
      preHandler: requireEquipmentRole(['equipment:technician', 'equipment:manager']),
    },
    async (request, reply) => {
      if (!db) {
        reply.code(503).send({ error: 'CouchDB is not available' })
        return
      }
      try {
        const { startDate, endDate } = request.query as { startDate?: string; endDate?: string }

        const start = startDate ? parseISO(startDate) : new Date()
        const end = endDate ? parseISO(endDate) : addDays(start, 30)

        const selector: any = {
          type: 'equipment',
          active: true,
          'maintenancePlan.nextDue': {
            $gte: start.toISOString(),
            $lte: end.toISOString(),
          },
        }

        const result = await db.find({
          selector,
          sort: [{ 'maintenancePlan.nextDue': 'asc' }],
        })

        // Group by date
        const calendar: Record<string, any[]> = {}
        for (const equipment of result.docs) {
          const nextDue = (equipment as any).maintenancePlan?.nextDue
          if (nextDue) {
            const dateKey = nextDue.split('T')[0] // YYYY-MM-DD
            if (!calendar[dateKey]) {
              calendar[dateKey] = []
            }
            calendar[dateKey].push(equipment)
          }
        }

        fastify.log.debug({ dateRange: { start, end }, count: result.docs.length }, 'maintenance.calendar')
        reply.send({ calendar, dateRange: { start: start.toISOString(), end: end.toISOString() } })
      } catch (error: unknown) {
        fastify.log.error(error as Error, 'maintenance.calendar_failed')
        reply.code(500).send({ error: 'Failed to get maintenance calendar' })
      }
    }
  )

  // Legacy routes for backward compatibility
  // GET /equipment/:id/history - Get maintenance history (legacy)
  fastify.get('/equipment/:id/history', async (request, reply) => {
    // Redirect to new endpoint
    const { id } = request.params as { id: string }
    reply.redirect(`/equipment/${id}/maintenance`, 302)
  })

  // POST /equipment/:id/calibrate - Record calibration (legacy)
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
        performerId: calibrationData.performedBy || 'system',
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
      reply.code(201).send({ id: calibration._id, rev: (calibration as any)._rev, ...calibration })
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
