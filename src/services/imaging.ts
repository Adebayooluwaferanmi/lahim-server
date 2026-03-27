import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'imaging')
    await ensureCouchDBDatabase(fastify, 'imaging_types')
  }

  // Only create database references if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Imaging service: CouchDB not available - endpoints will return errors')
    return
  }

  const db = fastify.couch.db.use('imaging')
  const imagingTypesDb = fastify.couch.db.use('imaging_types')

  // Create upload directory if it doesn't exist
  const uploadDir = process.env.IMAGING_UPLOAD_DIR || join(process.cwd(), 'uploads', 'imaging')
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
  }

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'imaging',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'requestedDate'] }, name: 'type-requestedDate-index' },
      { index: { fields: ['type', 'imagingDate'] }, name: 'type-imagingDate-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'visitId'] }, name: 'type-visitId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['requestedDate'] }, name: 'requestedDate-index' },
      { index: { fields: ['imagingDate'] }, name: 'imagingDate-index' },
    ],
    'Imaging'
  )
  createCouchDBIndexes(
    fastify,
    'imaging_types',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
      { index: { fields: ['name'] }, name: 'name-index' },
    ],
    'Imaging Types'
  )

  // ========== IMAGING ORDERS ==========

  // GET /imaging - List imaging orders
  fastify.get('/imaging', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, patientId, visitId, imagingType } = request.query as any
      const selector: any = { type: 'imaging' }

      if (status) selector.status = status
      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (imagingType) selector.imagingType = imagingType

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ requestedDate: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'imaging.list')
      reply.send({ imaging: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'imaging.list_failed')
      reply.code(500).send({ error: 'Failed to list imaging orders' })
    }
  })

  // GET /imaging/:id - Get single imaging order
  fastify.get('/imaging/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'imaging') {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }

      fastify.log.debug({ id }, 'imaging.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'imaging.get_failed')
      reply.code(500).send({ error: 'Failed to get imaging order' })
    }
  })

  // POST /imaging - Create imaging order
  fastify.post('/imaging', async (request, reply) => {
    try {
      const imaging = request.body as any

      if (!imaging.patientId || !imaging.imagingType || !imaging.requestedBy) {
        reply.code(400).send({ error: 'Patient ID, imaging type, and requested by are required' })
        return
      }

      const now = new Date().toISOString()
      const imagingDoc = {
        _id: `imaging_${Date.now()}_${randomUUID()}`,
        type: 'imaging',
        patientId: imaging.patientId,
        visitId: imaging.visitId,
        imagingType: imaging.imagingType,
        status: imaging.status || 'Requested',
        requestedBy: imaging.requestedBy,
        requestedDate: imaging.requestedDate || now,
        imagingDate: imaging.imagingDate,
        radiologist: imaging.radiologist,
        notes: imaging.notes,
        result: imaging.result,
        images: imaging.images || [],
        charges: imaging.charges || [],
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(imagingDoc)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('imaging.created', {
        id: result.id,
        patientId: imaging.patientId,
        visitId: imaging.visitId,
        imagingType: imaging.imagingType,
      })

      fastify.log.info({ id: result.id }, 'imaging.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'imaging.create_failed')
      reply.code(500).send({ error: 'Failed to create imaging order' })
    }
  })

  // PUT /imaging/:id - Update imaging order
  fastify.put('/imaging/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'imaging') {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('imaging.updated', {
        id,
        patientId: (existing as any).patientId,
        changes: Object.keys(updates),
      })

      fastify.log.info({ id }, 'imaging.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'imaging.update_failed')
      reply.code(500).send({ error: 'Failed to update imaging order' })
    }
  })

  // DELETE /imaging/:id - Delete imaging order
  fastify.delete('/imaging/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'imaging') {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }

      await db.destroy(id, (doc as any)._rev)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('imaging.deleted', {
        id,
        patientId: (doc as any).patientId,
      })

      fastify.log.info({ id }, 'imaging.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'imaging.delete_failed')
      reply.code(500).send({ error: 'Failed to delete imaging order' })
    }
  })

  // POST /imaging/:id/upload - Upload image file (base64 encoded)
  // Note: For now using base64 encoding. Can be upgraded to multipart/form-data later
  fastify.post('/imaging/:id/upload', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'imaging') {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }

      const body = request.body as any
      if (!body.file || !body.filename) {
        reply.code(400).send({ error: 'File data and filename are required' })
        return
      }

      // Handle base64 encoded file
      const fileId = randomUUID()
      const filename = `${fileId}_${body.filename}`
      const filepath = join(uploadDir, filename)

      // Decode base64 and save to disk
      const base64Data = body.file.replace(/^data:.*,/, '') // Remove data URL prefix if present
      const fileBuffer = Buffer.from(base64Data, 'base64')
      writeFileSync(filepath, fileBuffer)

      // Get file size
      const size = fileBuffer.length

      // Create image record
      const imageRecord = {
        id: fileId,
        filename: body.filename,
        contentType: body.contentType || 'application/octet-stream',
        size,
        url: `/imaging/${id}/images/${fileId}`,
        uploadedDate: new Date().toISOString(),
        uploadedBy: (request as any).user?.id || 'system',
        description: body.description,
      }

      // Update imaging order with new image
      const images = (doc as any).images || []
      images.push(imageRecord)

      const updated = {
        ...doc,
        images,
        updatedAt: new Date().toISOString(),
      }

      await db.insert(updated)

      fastify.log.info({ id, imageId: fileId }, 'imaging.image_uploaded')
      reply.code(201).send(imageRecord)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'imaging.upload_failed')
      reply.code(500).send({ error: 'Failed to upload image' })
    }
  })

  // GET /imaging/:id/images/:imageId - Get image file
  fastify.get('/imaging/:id/images/:imageId', async (request, reply) => {
    try {
      const { id, imageId } = request.params as { id: string; imageId: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'imaging') {
        reply.code(404).send({ error: 'Imaging order not found' })
        return
      }

      const images = (doc as any).images || []
      const image = images.find((img: any) => img.id === imageId)

      if (!image) {
        reply.code(404).send({ error: 'Image not found' })
        return
      }

      const filename = `${imageId}_${image.filename}`
      const filepath = join(uploadDir, filename)

      if (!existsSync(filepath)) {
        reply.code(404).send({ error: 'Image file not found' })
        return
      }

      const fileBuffer = readFileSync(filepath)
      reply.type(image.contentType)
      reply.send(fileBuffer)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging order or image not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'imaging.get_image_failed')
      reply.code(500).send({ error: 'Failed to get image' })
    }
  })

  // ========== IMAGING TYPES ==========

  // GET /imaging/types - List imaging types
  fastify.get('/imaging/types', async (request, reply) => {
    try {
      const { limit = 100, skip = 0, active, category } = request.query as any
      const selector: any = { type: 'imagingType' }

      if (active !== undefined) selector.active = active === 'true'
      if (category) selector.category = category

      const result = await imagingTypesDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'imaging_types.list')
      reply.send({ types: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'imaging_types.list_failed')
      reply.code(500).send({ error: 'Failed to list imaging types' })
    }
  })

  // GET /imaging/types/:id - Get single imaging type
  fastify.get('/imaging/types/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await imagingTypesDb.get(id)

      if ((doc as any).type !== 'imagingType') {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }

      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'imaging_types.get_failed')
      reply.code(500).send({ error: 'Failed to get imaging type' })
    }
  })

  // POST /imaging/types - Create imaging type
  fastify.post('/imaging/types', async (request, reply) => {
    try {
      const type = request.body as any

      if (!type.name) {
        reply.code(400).send({ error: 'Name is required' })
        return
      }

      const now = new Date().toISOString()
      const typeDoc = {
        _id: `imagingType_${Date.now()}_${randomUUID()}`,
        type: 'imagingType',
        name: type.name,
        code: type.code,
        description: type.description,
        category: type.category,
        active: type.active !== undefined ? type.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await imagingTypesDb.insert(typeDoc)
      fastify.log.info({ id: result.id }, 'imaging_types.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'imaging_types.create_failed')
      reply.code(500).send({ error: 'Failed to create imaging type' })
    }
  })

  // PUT /imaging/types/:id - Update imaging type
  fastify.put('/imaging/types/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await imagingTypesDb.get(id)
      if ((existing as any).type !== 'imagingType') {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await imagingTypesDb.insert(updated)
      fastify.log.info({ id }, 'imaging_types.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'imaging_types.update_failed')
      reply.code(500).send({ error: 'Failed to update imaging type' })
    }
  })

  // DELETE /imaging/types/:id - Delete imaging type
  fastify.delete('/imaging/types/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await imagingTypesDb.get(id)

      if ((doc as any).type !== 'imagingType') {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }

      await imagingTypesDb.destroy(id, (doc as any)._rev)
      fastify.log.info({ id }, 'imaging_types.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Imaging type not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'imaging_types.delete_failed')
      reply.code(500).send({ error: 'Failed to delete imaging type' })
    }
  })

}

