import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { randomUUID } from 'crypto'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'documents')
  }

  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Documents service: CouchDB not available - endpoints will return errors')
    return
  }

  const db = fastify.couch.db.use('documents')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'documents',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'uploadedDate'] }, name: 'type-uploadedDate-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'visitId'] }, name: 'type-visitId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['patientId'] }, name: 'patientId-index' },
      { index: { fields: ['visitId'] }, name: 'visitId-index' },
      { index: { fields: ['uploadedDate'] }, name: 'uploadedDate-index' },
      { index: { fields: ['documentNumber'] }, name: 'documentNumber-index' },
    ],
    'Documents'
  )

  // Helper function to generate document number
  const generateDocumentNumber = async (docType: string): Promise<string> => {
    const year = new Date().getFullYear()
    const typeCode = docType.substring(0, 3).toUpperCase().replace(/\s/g, '')
    const prefix = `DOC-${year}-${typeCode}-`
    
    try {
      const result = await db.find({
        selector: {
          type: 'document',
          documentType: docType,
          documentNumber: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
        },
        limit: 1,
        sort: [{ documentNumber: 'desc' }],
      })

      if (result.docs.length > 0) {
        const lastNumber = (result.docs[0] as any).documentNumber
        const lastSeq = parseInt(lastNumber.replace(prefix, ''), 10) || 0
        return `${prefix}${String(lastSeq + 1).padStart(6, '0')}`
      }
    } catch (error) {
      fastify.log.warn({ error }, 'Error generating document number, starting from 1')
    }

    return `${prefix}000001`
  }

  // ========== DOCUMENTS ==========

  // GET /documents - List documents
  fastify.get('/documents', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, type, status, patientId, visitId, category } = request.query as any
      const selector: any = { type: 'document' }

      if (type) selector.documentType = type
      if (status) selector.status = status
      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (category) selector.category = category

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ uploadedDate: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'documents.list')
      reply.send({ documents: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'documents.list_failed')
      reply.code(500).send({ error: 'Failed to list documents' })
    }
  })

  // GET /documents/:id - Get single document
  fastify.get('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      fastify.log.debug({ id }, 'documents.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'documents.get_failed')
      reply.code(500).send({ error: 'Failed to get document' })
    }
  })

  // GET /documents/:id/download - Download document file
  fastify.get('/documents/:id/download', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      const document = doc as any
      const fileBuffer = Buffer.from(document.data, 'base64')

      reply.type(document.contentType)
      reply.header('Content-Disposition', `attachment; filename="${document.originalFilename || document.filename}"`)
      reply.header('Content-Length', fileBuffer.length.toString())

      fastify.log.info({ id, filename: document.filename }, 'documents.downloaded')
      reply.send(fileBuffer)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'documents.download_failed')
      reply.code(500).send({ error: 'Failed to download document' })
    }
  })

  // GET /documents/:id/view - View document (inline)
  fastify.get('/documents/:id/view', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      const document = doc as any
      const fileBuffer = Buffer.from(document.data, 'base64')

      reply.type(document.contentType)
      reply.header('Content-Disposition', `inline; filename="${document.originalFilename || document.filename}"`)
      reply.header('Content-Length', fileBuffer.length.toString())

      fastify.log.info({ id, filename: document.filename }, 'documents.viewed')
      reply.send(fileBuffer)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'documents.view_failed')
      reply.code(500).send({ error: 'Failed to view document' })
    }
  })

  // POST /documents - Upload/create document
  fastify.post('/documents', async (request, reply) => {
    try {
      const documentData = request.body as any

      if (!documentData.filename || !documentData.data || !documentData.contentType) {
        reply.code(400).send({ error: 'Filename, data, and content type are required' })
        return
      }

      const now = new Date().toISOString()
      const documentNumber = await generateDocumentNumber(documentData.type || 'General')

      const documentDoc = {
        _id: `document_${Date.now()}_${randomUUID()}`,
        type: 'document',
        documentNumber,
        documentType: documentData.type || 'General',
        status: documentData.status || 'Final',
        title: documentData.title || documentData.originalFilename || documentData.filename,
        description: documentData.description,
        filename: documentData.filename,
        originalFilename: documentData.originalFilename || documentData.filename,
        contentType: documentData.contentType,
        size: documentData.size || (documentData.data ? Buffer.from(documentData.data, 'base64').length : 0),
        data: documentData.data, // Base64 encoded
        patientId: documentData.patientId,
        visitId: documentData.visitId,
        relatedEntityType: documentData.relatedEntityType,
        relatedEntityId: documentData.relatedEntityId,
        uploadedBy: documentData.uploadedBy || 'system',
        uploadedDate: now,
        lastModified: now,
        modifiedBy: documentData.modifiedBy,
        tags: documentData.tags || [],
        category: documentData.category,
        isPublic: documentData.isPublic !== undefined ? documentData.isPublic : false,
        accessLevel: documentData.accessLevel || 'Restricted',
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(documentDoc)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('document.created', {
        id: result.id,
        documentNumber,
        type: documentData.type,
        patientId: documentData.patientId,
      })

      fastify.log.info({ id: result.id, documentNumber, filename: documentData.filename }, 'documents.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'documents.create_failed')
      reply.code(500).send({ error: 'Failed to create document' })
    }
  })

  // PUT /documents/:id - Update document metadata
  fastify.put('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      // Don't allow updating file data through PUT - use upload endpoint for that
      const { data, ...metadataUpdates } = updates

      const updated = {
        ...existing,
        ...metadataUpdates,
        lastModified: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      fastify.log.info({ id }, 'documents.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'documents.update_failed')
      reply.code(500).send({ error: 'Failed to update document' })
    }
  })

  // DELETE /documents/:id - Delete document
  fastify.delete('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'document') {
        reply.code(404).send({ error: 'Document not found' })
        return
      }

      await db.destroy(id, (doc as any)._rev)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('document.deleted', {
        id,
        documentNumber: (doc as any).documentNumber,
      })

      fastify.log.info({ id }, 'documents.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Document not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'documents.delete_failed')
      reply.code(500).send({ error: 'Failed to delete document' })
    }
  })

}

