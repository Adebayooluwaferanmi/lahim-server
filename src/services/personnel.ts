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
    await ensureCouchDBDatabase(fastify, 'personnel')
    await ensureCouchDBDatabase(fastify, 'shifts')
    await ensureCouchDBDatabase(fastify, 'competencies')
    await ensureCouchDBDatabase(fastify, 'training')
  }

  // Register stub endpoints if CouchDB is not available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Personnel service: CouchDB not available - registering stub endpoints')
    
    fastify.get('/personnel', async (_request, reply) => {
      reply.send({ staff: [], count: 0 })
    })
    
    fastify.post('/personnel', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/personnel/shifts', async (_request, reply) => {
      reply.send({ shifts: [], count: 0 })
    })
    
    fastify.post('/personnel/shifts', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/personnel/competencies', async (_request, reply) => {
      reply.send({ competencies: [], count: 0 })
    })
    
    fastify.post('/personnel/competencies', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    fastify.get('/personnel/training', async (_request, reply) => {
      reply.send({ training: [], count: 0 })
    })
    
    fastify.post('/personnel/training', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })
    
    next()
    return
  }

  const personnelDb = fastify.couch.db.use('personnel')
  const shiftsDb = fastify.couch.db.use('shifts')
  const competenciesDb = fastify.couch.db.use('competencies')
  const trainingDb = fastify.couch.db.use('training')
  const cache = createMetricsCacheHelper(fastify, 'personnel')

  // Create indexes
  createCouchDBIndexes(
    fastify,
    'personnel',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
      { index: { fields: ['type', 'department'] }, name: 'type-department-index' },
    ],
    'Personnel'
  )

  createCouchDBIndexes(
    fastify,
    'shifts',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'staffId'] }, name: 'type-staffId-index' },
      { index: { fields: ['type', 'startDate'] }, name: 'type-startDate-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Shifts'
  )

  createCouchDBIndexes(
    fastify,
    'competencies',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'staffId'] }, name: 'type-staffId-index' },
      { index: { fields: ['type', 'expiryDate'] }, name: 'type-expiryDate-index' },
    ],
    'Competencies'
  )

  createCouchDBIndexes(
    fastify,
    'training',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'staffId'] }, name: 'type-staffId-index' },
      { index: { fields: ['type', 'completedDate'] }, name: 'type-completedDate-index' },
    ],
    'Training'
  )

  // ========== PERSONNEL MANAGEMENT ==========

  // GET /personnel - List personnel
  fastify.get('/personnel', async (request, reply) => {
    try {
      const { department, active, limit = 50, skip = 0 } = request.query as any
      
      const cacheKey = `personnel:${department || 'all'}:${active || 'all'}:${limit}:${skip}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'staff' }
      if (department) selector.department = department
      if (active !== undefined) selector.active = active === 'true'

      const result = await personnelDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      const response = { staff: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.list_failed')
      reply.code(500).send({ error: 'Failed to list personnel' })
    }
  })

  // POST /personnel - Create/update staff member
  fastify.post('/personnel', async (request, reply) => {
    try {
      const staff = request.body as any

      if (!staff.name || !staff.role) {
        reply.code(400).send({ error: 'Name and role are required' })
        return
      }

      const now = new Date().toISOString()
      
      // Check if staff already exists
      const existing = await personnelDb.find({
        selector: { type: 'staff', employeeId: staff.employeeId },
        limit: 1,
      })

      let result: any
      if (existing.docs.length > 0) {
        // Update existing
        const updated = {
          ...existing.docs[0],
          ...staff,
          updatedAt: now,
        }
        result = await personnelDb.insert(updated)
      } else {
        // Create new
        const newStaff = {
          ...staff,
          type: 'staff',
          active: staff.active !== undefined ? staff.active : true,
          createdAt: now,
          updatedAt: now,
        }
        result = await personnelDb.insert(newStaff)
      }

      await cache.deletePattern('personnel:*')

      fastify.log.info({ employeeId: staff.employeeId }, 'personnel.updated')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.create_failed')
      reply.code(500).send({ error: 'Failed to create staff member' })
    }
  })

  // ========== SHIFT MANAGEMENT ==========

  // GET /personnel/shifts - List shifts
  fastify.get('/personnel/shifts', async (request, reply) => {
    try {
      const { staffId, startDate, endDate, status } = request.query as any
      
      const cacheKey = `personnel:shifts:${staffId || 'all'}:${startDate || 'all'}:${endDate || 'all'}:${status || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'shift' }
      if (staffId) selector.staffId = staffId
      if (status) selector.status = status
      if (startDate || endDate) {
        selector.startDate = {}
        if (startDate) selector.startDate.$gte = startDate
        if (endDate) selector.startDate.$lte = endDate
      }

      const result = await shiftsDb.find({
        selector,
        limit: 1000,
        sort: [{ startDate: 'asc' }],
      })

      const response = { shifts: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.shifts.list_failed')
      reply.code(500).send({ error: 'Failed to list shifts' })
    }
  })

  // POST /personnel/shifts - Create shift
  fastify.post('/personnel/shifts', async (request, reply) => {
    try {
      const shift = request.body as any

      if (!shift.staffId || !shift.startDate || !shift.endDate) {
        reply.code(400).send({ error: 'Staff ID, start date, and end date are required' })
        return
      }

      const now = new Date().toISOString()

      const newShift = {
        ...shift,
        type: 'shift',
        status: shift.status || 'scheduled',
        createdAt: now,
        updatedAt: now,
      }

      const result = await shiftsDb.insert(newShift)
      await cache.deletePattern('personnel:shifts:*')

      fastify.log.info({ staffId: shift.staffId, startDate: shift.startDate }, 'personnel.shift.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.shift.create_failed')
      reply.code(500).send({ error: 'Failed to create shift' })
    }
  })

  // ========== COMPETENCY TRACKING ==========

  // GET /personnel/competencies - List competencies
  fastify.get('/personnel/competencies', async (request, reply) => {
    try {
      const { staffId } = request.query as any
      
      const cacheKey = `personnel:competencies:${staffId || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'competency' }
      if (staffId) selector.staffId = staffId

      const result = await competenciesDb.find({
        selector,
        limit: 1000,
        sort: [{ expiryDate: 'asc' }],
      })

      const response = { competencies: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.competencies.list_failed')
      reply.code(500).send({ error: 'Failed to list competencies' })
    }
  })

  // POST /personnel/competencies - Record competency
  fastify.post('/personnel/competencies', async (request, reply) => {
    try {
      const competency = request.body as any

      if (!competency.staffId || !competency.skill || !competency.level) {
        reply.code(400).send({ error: 'Staff ID, skill, and level are required' })
        return
      }

      const now = new Date().toISOString()

      const newCompetency = {
        ...competency,
        type: 'competency',
        assessedDate: competency.assessedDate || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await competenciesDb.insert(newCompetency)
      await cache.deletePattern('personnel:competencies:*')

      fastify.log.info({ staffId: competency.staffId, skill: competency.skill }, 'personnel.competency.recorded')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.competency.create_failed')
      reply.code(500).send({ error: 'Failed to record competency' })
    }
  })

  // ========== TRAINING MANAGEMENT ==========

  // GET /personnel/training - List training records
  fastify.get('/personnel/training', async (request, reply) => {
    try {
      const { staffId, completed } = request.query as any
      
      const cacheKey = `personnel:training:${staffId || 'all'}:${completed || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const selector: any = { type: 'training' }
      if (staffId) selector.staffId = staffId
      if (completed !== undefined) selector.completed = completed === 'true'

      const result = await trainingDb.find({
        selector,
        limit: 1000,
        sort: [{ completedDate: 'desc' }],
      })

      const response = { training: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300)

      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.training.list_failed')
      reply.code(500).send({ error: 'Failed to list training records' })
    }
  })

  // POST /personnel/training - Record training
  fastify.post('/personnel/training', async (request, reply) => {
    try {
      const training = request.body as any

      if (!training.staffId || !training.course || !training.trainingDate) {
        reply.code(400).send({ error: 'Staff ID, course, and training date are required' })
        return
      }

      const now = new Date().toISOString()

      const newTraining = {
        ...training,
        type: 'training',
        completed: training.completed !== undefined ? training.completed : false,
        createdAt: now,
        updatedAt: now,
      }

      const result = await trainingDb.insert(newTraining)
      await cache.deletePattern('personnel:training:*')

      fastify.log.info({ staffId: training.staffId, course: training.course }, 'personnel.training.recorded')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'personnel.training.create_failed')
      reply.code(500).send({ error: 'Failed to record training' })
    }
  })

  next()
}

