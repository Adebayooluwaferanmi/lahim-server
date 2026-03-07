/**
 * Audit Management Service
 * Manages internal audits, findings, and CAPA for ISO 15189 compliance
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { randomUUID } from 'crypto'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: any) => void,
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'audits')
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Audits service: CouchDB not available - endpoints will return errors')
    next()
    return
  }

  const db = fastify.couch.db.use('audits')
  const cache = createMetricsCacheHelper(fastify, 'audits')

  // Create indexes
  createCouchDBIndexes(
    fastify,
    'audits',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['auditNumber'] }, name: 'auditNumber-index' },
      { index: { fields: ['status'] }, name: 'status-index' },
      { index: { fields: ['scheduledDate'] }, name: 'scheduledDate-index' },
      { index: { fields: ['department'] }, name: 'department-index' },
    ],
    'Audits'
  )

  // Helper to generate audit number
  const generateAuditNumber = async (): Promise<string> => {
    const year = new Date().getFullYear()
    const prefix = `AUD-${year}-`
    
    try {
      const result = await db.find({
        selector: {
          type: 'audit',
          auditNumber: { $regex: `^${prefix}` },
        },
        limit: 1,
        sort: [{ auditNumber: 'desc' }],
      })

      if (result.docs.length > 0) {
        const lastNumber = (result.docs[0] as any).auditNumber
        const lastSeq = parseInt(lastNumber.replace(prefix, ''), 10) || 0
        return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
      }
    } catch (error) {
      fastify.log.warn({ error }, 'Error generating audit number, starting from 1')
    }

    return `${prefix}0001`
  }

  // GET /audits - List audits
  fastify.get('/audits', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, type, status, department } = request.query as any
      
      const cacheKey = `audits:${type || 'all'}:${status || 'all'}:${department || 'all'}:${limit}:${skip}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'audits.list_cache_hit')
        return reply.send(cached)
      }

      const selector: any = { type: 'audit' }
      if (type) selector.auditType = type
      if (status) selector.status = status
      if (department) selector.department = department

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ scheduledDate: 'desc' }],
      })

      const response = { audits: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300) // 5 minutes

      fastify.log.info({ count: result.docs.length }, 'audits.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'audits.list_failed')
      reply.code(500).send({ error: 'Failed to list audits' })
    }
  })

  // GET /audits/:id - Get single audit
  fastify.get('/audits/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      const cacheKey = `audits:${id}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'audits.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)
      if ((doc as any).type !== 'audit') {
        reply.code(404).send({ error: 'Audit not found' })
        return
      }

      // Get findings and CAPA if available
      let findings: any[] = []
      let capa: any[] = []

      if (fastify.prisma) {
        try {
          findings = await fastify.prisma.auditFinding.findMany({
            where: { auditId: id },
            orderBy: { createdAt: 'desc' },
          })

          capa = await fastify.prisma.correctiveAction.findMany({
            where: { auditId: id },
            orderBy: { createdAt: 'desc' },
          })
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'Failed to fetch findings/CAPA from PostgreSQL')
        }
      }

      const response = {
        ...doc,
        findings: findings.length > 0 ? findings : (doc as any).findings || [],
        capa: capa.length > 0 ? capa : (doc as any).capa || [],
      }

      await cache.set(cacheKey, response, 600) // 10 minutes
      fastify.log.debug({ id }, 'audits.get')
      reply.send(response)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Audit not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'audits.get_failed')
      reply.code(500).send({ error: 'Failed to get audit' })
    }
  })

  // POST /audits - Create audit
  fastify.post('/audits', async (request, reply) => {
    try {
      const auditData = request.body as any

      if (!auditData.scope || !auditData.auditType || !auditData.scheduledDate) {
        reply.code(400).send({ error: 'Scope, audit type, and scheduled date are required' })
        return
      }

      const now = new Date().toISOString()
      const auditNumber = await generateAuditNumber()

      const newAudit = {
        _id: `audit_${Date.now()}_${randomUUID()}`,
        type: 'audit',
        auditNumber,
        auditType: auditData.auditType,
        scope: auditData.scope,
        status: auditData.status || 'planned',
        scheduledDate: auditData.scheduledDate,
        conductedDate: auditData.conductedDate,
        conductedBy: auditData.conductedBy,
        auditorName: auditData.auditorName,
        department: auditData.department,
        findings: auditData.findings,
        conclusion: auditData.conclusion,
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write to PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.audit.create({
            data: {
              id: newAudit._id,
              auditNumber,
              type: auditData.auditType,
              scope: auditData.scope,
              status: auditData.status || 'planned',
              scheduledDate: new Date(auditData.scheduledDate),
              conductedDate: auditData.conductedDate ? new Date(auditData.conductedDate) : null,
              conductedBy: auditData.conductedBy,
              auditorName: auditData.auditorName,
              department: auditData.department,
              findings: auditData.findings ? JSON.stringify(auditData.findings) : null,
              conclusion: auditData.conclusion,
            },
          })
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL audit write failed, continuing with CouchDB only')
        }
      }

      const result = await db.insert(newAudit)

      // Invalidate cache
      await cache.deletePattern('audits:*')

      fastify.log.info({ id: result.id, auditNumber }, 'audits.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newAudit })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'audits.create_failed')
      reply.code(500).send({ error: 'Failed to create audit' })
    }
  })

  // POST /audits/:id/findings - Add finding
  fastify.post('/audits/:id/findings', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const findingData = request.body as any

      if (!findingData.description || !findingData.severity) {
        reply.code(400).send({ error: 'Description and severity are required' })
        return
      }

      // Verify audit exists
      const audit = await db.get(id)
      if ((audit as any).type !== 'audit') {
        reply.code(404).send({ error: 'Audit not found' })
        return
      }

      // Create finding in PostgreSQL if available
      if (fastify.prisma) {
        try {
          const finding = await fastify.prisma.auditFinding.create({
            data: {
              auditId: id,
              severity: findingData.severity,
              description: findingData.description,
              clause: findingData.clause,
              status: findingData.status || 'open',
              assignedTo: findingData.assignedTo,
              dueDate: findingData.dueDate ? new Date(findingData.dueDate) : null,
            },
          })

          // Invalidate cache
          await cache.deletePattern('audits:*')

          fastify.log.info({ auditId: id, findingId: finding.id }, 'audits.finding_created')
          reply.code(201).send(finding)
          return
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL finding creation failed')
        }
      }

      // Fallback: store in CouchDB audit document
      const findings = (audit as any).findings || []
      findings.push({
        id: `finding_${Date.now()}_${randomUUID()}`,
        ...findingData,
        createdAt: new Date().toISOString(),
      })

      const updated = {
        ...audit,
        findings,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Invalidate cache
      await cache.deletePattern('audits:*')

      fastify.log.info({ auditId: id }, 'audits.finding_created')
      reply.code(201).send({ id: result.id, rev: result.rev, finding: findings[findings.length - 1] })
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error }, 'audits.finding_create_failed')
      reply.code(500).send({ error: 'Failed to create finding' })
    }
  })

  // POST /audits/:id/capa - Add corrective action
  fastify.post('/audits/:id/capa', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const capaData = request.body as any

      if (!capaData.description || !capaData.actionPlan || !capaData.dueDate) {
        reply.code(400).send({ error: 'Description, action plan, and due date are required' })
        return
      }

      // Verify audit exists
      const audit = await db.get(id)
      if ((audit as any).type !== 'audit') {
        reply.code(404).send({ error: 'Audit not found' })
        return
      }

      // Create CAPA in PostgreSQL if available
      if (fastify.prisma) {
        try {
          const capa = await fastify.prisma.correctiveAction.create({
            data: {
              auditId: id,
              findingId: capaData.findingId,
              type: capaData.type || 'corrective',
              description: capaData.description,
              rootCause: capaData.rootCause,
              actionPlan: capaData.actionPlan,
              assignedTo: capaData.assignedTo,
              dueDate: new Date(capaData.dueDate),
              status: capaData.status || 'open',
            },
          })

          // Invalidate cache
          await cache.deletePattern('audits:*')

          fastify.log.info({ auditId: id, capaId: capa.id }, 'audits.capa_created')
          reply.code(201).send(capa)
          return
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL CAPA creation failed')
        }
      }

      // Fallback: store in CouchDB audit document
      const capa = (audit as any).capa || []
      capa.push({
        id: `capa_${Date.now()}_${randomUUID()}`,
        ...capaData,
        createdAt: new Date().toISOString(),
      })

      const updated = {
        ...audit,
        capa,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Invalidate cache
      await cache.deletePattern('audits:*')

      fastify.log.info({ auditId: id }, 'audits.capa_created')
      reply.code(201).send({ id: result.id, rev: result.rev, capa: capa[capa.length - 1] })
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error }, 'audits.capa_create_failed')
      reply.code(500).send({ error: 'Failed to create CAPA' })
    }
  })

  next()
}

