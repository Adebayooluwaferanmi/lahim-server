/**
 * Document Control Service
 * Manages SOPs, policies, procedures for ISO 15189 compliance
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
    await ensureCouchDBDatabase(fastify, 'document_control')
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Document Control service: CouchDB not available - endpoints will return stub responses')
    
    // Register stub endpoints when CouchDB is unavailable
    fastify.get('/document-control', async (request, reply) => {
      reply.send({ documents: [], count: 0 })
    })
    
    fastify.get('/document-control/:id', async (request, reply) => {
      reply.code(503).send({ error: 'CouchDB is not available' })
    })
    
    fastify.post('/document-control', async (request, reply) => {
      reply.code(503).send({ error: 'CouchDB is not available' })
    })
    
    fastify.put('/document-control/:id', async (request, reply) => {
      reply.code(503).send({ error: 'CouchDB is not available' })
    })
    
    fastify.post('/document-control/:id/approve', async (request, reply) => {
      reply.code(503).send({ error: 'CouchDB is not available' })
    })
    
    next()
    return
  }

  const db = fastify.couch.db.use('document_control')
  const cache = createMetricsCacheHelper(fastify, 'document-control')

  // Create indexes
  createCouchDBIndexes(
    fastify,
    'document_control',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'category'] }, name: 'type-category-index' },
      { index: { fields: ['documentNumber'] }, name: 'documentNumber-index' },
      { index: { fields: ['status'] }, name: 'status-index' },
    ],
    'Document Control'
  )

  // Helper to generate document number
  const generateDocumentNumber = async (type: string): Promise<string> => {
    const year = new Date().getFullYear()
    const prefix = `DOC-${year}-${type.substring(0, 3).toUpperCase()}-`
    
    try {
      const result = await db.find({
        selector: {
          type: 'document',
          documentType: type,
          documentNumber: { $regex: `^${prefix}` },
        },
        limit: 1,
        sort: [{ documentNumber: 'desc' }],
      })

      if (result.docs.length > 0) {
        const lastNumber = (result.docs[0] as any).documentNumber
        const lastSeq = parseInt(lastNumber.replace(prefix, ''), 10) || 0
        return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
      }
    } catch (error) {
      fastify.log.warn({ error }, 'Error generating document number, starting from 1')
    }

    return `${prefix}0001`
  }

  // GET /document-control - List documents
  fastify.get('/document-control', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, type, status, category } = request.query as any
      
      const cacheKey = `document-control:${type || 'all'}:${status || 'all'}:${category || 'all'}:${limit}:${skip}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'document_control.list_cache_hit')
        return reply.send(cached)
      }

      const selector: any = { type: 'document' }
      if (type) selector.documentType = type
      if (status) selector.status = status
      if (category) selector.category = category

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ documentNumber: 'desc' }],
      })

      const response = { documents: result.docs, count: result.docs.length }
      await cache.set(cacheKey, response, 300) // 5 minutes

      fastify.log.info({ count: result.docs.length }, 'document_control.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'document_control.list_failed')
      reply.code(500).send({ error: 'Failed to list documents' })
    }
  })

  // GET /document-control/:id - Get single document
  fastify.get('/document-control/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      const cacheKey = `document-control:${id}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'document_control.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)
      if ((doc as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      await cache.set(cacheKey, doc, 600) // 10 minutes
      fastify.log.debug({ id }, 'document_control.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'document_control.get_failed')
      reply.code(500).send({ error: 'Failed to get document' })
    }
  })

  // POST /document-control - Create document
  fastify.post('/document-control', async (request, reply) => {
    try {
      const docData = request.body as any

      if (!docData.title || !docData.documentType) {
        reply.code(400).send({ error: 'Title and document type are required' })
        return
      }

      const now = new Date().toISOString()
      const documentNumber = await generateDocumentNumber(docData.documentType)

      const newDocument = {
        _id: `document_${Date.now()}_${randomUUID()}`,
        type: 'document',
        documentNumber,
        documentType: docData.documentType,
        category: docData.category,
        title: docData.title,
        description: docData.description,
        version: docData.version || '1.0',
        status: docData.status || 'draft',
        filename: docData.filename,
        filePath: docData.filePath,
        contentType: docData.contentType,
        fileSize: docData.fileSize,
        effectiveDate: docData.effectiveDate,
        reviewDate: docData.reviewDate,
        nextReviewDate: docData.nextReviewDate,
        approvedBy: docData.approvedBy,
        approvedOn: docData.approvedOn,
        createdBy: docData.createdBy || 'system',
        createdAt: now,
        updatedAt: now,
      }

      // Dual-write to PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.document.create({
            data: {
              id: newDocument._id,
              documentNumber,
              type: docData.documentType,
              category: docData.category,
              title: docData.title,
              description: docData.description,
              version: docData.version || '1.0',
              status: docData.status || 'draft',
              filename: docData.filename,
              filePath: docData.filePath,
              contentType: docData.contentType,
              fileSize: docData.fileSize,
              effectiveDate: docData.effectiveDate ? new Date(docData.effectiveDate) : null,
              reviewDate: docData.reviewDate ? new Date(docData.reviewDate) : null,
              nextReviewDate: docData.nextReviewDate ? new Date(docData.nextReviewDate) : null,
              approvedBy: docData.approvedBy,
              approvedOn: docData.approvedOn ? new Date(docData.approvedOn) : null,
              createdBy: docData.createdBy || 'system',
            },
          })
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL document write failed, continuing with CouchDB only')
        }
      }

      const result = await db.insert(newDocument)

      // Invalidate cache
      await cache.deletePattern('document-control:*')

      fastify.log.info({ id: result.id, documentNumber }, 'document_control.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newDocument })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'document_control.create_failed')
      reply.code(500).send({ error: 'Failed to create document' })
    }
  })

  // PUT /document-control/:id - Update document
  fastify.put('/document-control/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any
      if (existing.type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      // Dual-write to PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.document.update({
            where: { id },
            data: {
              ...updates,
              effectiveDate: updates.effectiveDate ? new Date(updates.effectiveDate) : undefined,
              reviewDate: updates.reviewDate ? new Date(updates.reviewDate) : undefined,
              nextReviewDate: updates.nextReviewDate ? new Date(updates.nextReviewDate) : undefined,
              approvedOn: updates.approvedOn ? new Date(updates.approvedOn) : undefined,
            },
          })
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL document update failed, continuing with CouchDB only')
        }
      }

      const result = await db.insert(updated)

      // Invalidate cache
      await cache.deletePattern('document-control:*')
      await cache.delete(`document-control:${id}`)

      fastify.log.info({ id }, 'document_control.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'document_control.update_failed')
      reply.code(500).send({ error: 'Failed to update document' })
    }
  })

  // POST /document-control/:id/approve - Approve document
  fastify.post('/document-control/:id/approve', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { approverId, approverName, comments } = request.body as any

      const existing = await db.get(id) as any
      if (existing.type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      const now = new Date().toISOString()
      const updated = {
        ...existing,
        status: 'approved',
        approvedBy: approverId,
        approvedOn: now,
        updatedAt: now,
      }

      // Dual-write to PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.document.update({
            where: { id },
            data: {
              status: 'approved',
              approvedBy: approverId,
              approvedOn: new Date(),
            },
          })

          // Create approval record
          await fastify.prisma.documentApproval.create({
            data: {
              documentId: id,
              approverId,
              approverName,
              status: 'approved',
              comments,
              approvedAt: new Date(),
            },
          })
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL approval failed, continuing with CouchDB only')
        }
      }

      const result = await db.insert(updated)

      // Invalidate cache
      await cache.deletePattern('document-control:*')

      fastify.log.info({ id, approverId }, 'document_control.approved')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error }, 'document_control.approve_failed')
      reply.code(500).send({ error: 'Failed to approve document' })
    }
  })

  next()
}

