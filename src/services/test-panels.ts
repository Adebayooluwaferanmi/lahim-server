import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    try {
      await ensureCouchDBDatabase(fastify, 'test_panels')
    } catch (error) {
      fastify.log.warn({ error }, 'Failed to ensure test_panels database, continuing anyway')
    }
  }

  const db = fastify.couchAvailable && fastify.couch 
    ? fastify.couch.db.use('test_panels')
    : null

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'test_panels',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'code'] }, name: 'type-code-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
      { index: { fields: ['type', 'department'] }, name: 'type-department-index' },
    ],
    'Test panels'
  )

  // GET /test-panels - List all test panels
  fastify.get('/test-panels', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { limit = 50, skip = 0, active, department, code } = request.query as any
      const selector: any = { type: 'testPanel' }

      if (active !== undefined) {
        selector.active = active === 'true'
      }
      if (department) {
        selector.department = department
      }
      if (code) {
        selector.code = code
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ code: 'asc' }],
      })

      fastify.log.info({ count: result.docs.length, limit, skip }, 'test_panels.list')
      
      // If code is specified, return single panel, otherwise return list
      if (code && result.docs.length > 0) {
        reply.send(result.docs[0])
      } else {
        reply.send({ panels: result.docs, count: result.docs.length })
      }
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'test_panels.list_failed')
      reply.code(500).send({ error: 'Failed to list test panels' })
    }
  })

  // GET /test-panels/:id - Get single test panel with parameters
  fastify.get('/test-panels/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      // If PostgreSQL is available, enrich with parameter details
      if (fastify.prisma) {
        try {
          const panel = await fastify.prisma.testPanel.findUnique({
            where: { id },
            include: {
              parameters: {
                include: {
                  testCatalog: true,
                },
                orderBy: { sequence: 'asc' },
              },
            },
          })

          if (panel) {
            // Merge CouchDB doc with Prisma data
            const enriched = {
              ...doc,
              parameters: panel.parameters.map((p: any) => ({
                id: p.id,
                parameterCode: p.parameterCode,
                parameterName: p.parameterName,
                sequence: p.sequence,
                unit: p.unit,
                refRangeLow: p.refRangeLow,
                refRangeHigh: p.refRangeHigh,
                criticalLow: p.criticalLow,
                criticalHigh: p.criticalHigh,
                defaultValue: p.defaultValue,
                required: p.required,
                active: p.active,
                testCatalog: p.testCatalog ? {
                  code: p.testCatalog.code,
                  name: p.testCatalog.name,
                } : null,
              })),
            }
            reply.send(enriched)
            return
          }
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL panel query failed, using CouchDB only')
        }
      }

      fastify.log.debug({ id }, 'test_panels.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'test_panels.get_failed')
      reply.code(500).send({ error: 'Failed to get test panel' })
    }
  })

  // POST /test-panels - Create new test panel
  fastify.post('/test-panels', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const panel = request.body as any

      if (!panel.code || !panel.name) {
        reply.code(400).send({ error: 'Code and name are required' })
        return
      }

      // Check for duplicate code
      const existing = await db.find({
        selector: { type: 'testPanel', code: panel.code },
        limit: 1,
      })

      if (existing.docs.length > 0) {
        reply.code(409).send({ error: 'Panel code already exists' })
        return
      }

      const now = new Date().toISOString()
      const newPanel = {
        ...panel,
        type: 'testPanel',
        active: panel.active !== undefined ? panel.active : true,
        parameters: panel.parameters || [],
        createdAt: now,
        updatedAt: now,
      }

      // Generate ID if not provided
      if (!newPanel._id) {
        newPanel._id = `test_panel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      }

      const result = await db.insert(newPanel)

      // Write to PostgreSQL if available
      if (fastify.prisma) {
        try {
          const prismaPanel = await fastify.prisma.testPanel.create({
            data: {
              id: result.id,
              code: newPanel.code,
              name: newPanel.name,
              description: newPanel.description,
              department: newPanel.department,
              active: newPanel.active,
              parameters: {
                create: (newPanel.parameters || []).map((param: any, index: number) => ({
                  parameterCode: param.parameterCode,
                  parameterName: param.parameterName,
                  sequence: param.sequence || index + 1,
                  unit: param.unit,
                  refRangeLow: param.refRangeLow,
                  refRangeHigh: param.refRangeHigh,
                  criticalLow: param.criticalLow,
                  criticalHigh: param.criticalHigh,
                  defaultValue: param.defaultValue,
                  required: param.required !== false,
                  active: param.active !== false,
                })),
              },
            },
            include: {
              parameters: true,
            },
          })
          fastify.log.info({ panelId: prismaPanel.id }, 'test_panels.created_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL panel creation failed, CouchDB only')
        }
      }

      fastify.log.info({ id: result.id, code: newPanel.code }, 'test_panels.created')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newPanel })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'test_panels.create_failed')
      reply.code(500).send({ error: 'Failed to create test panel' })
    }
  })

  // PUT /test-panels/:id - Update test panel
  fastify.put('/test-panels/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const update = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      const updated = {
        ...existing,
        ...update,
        _id: id,
        _rev: (existing as any)._rev,
        type: 'testPanel',
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Update PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.testPanel.update({
            where: { id },
            data: {
              code: updated.code,
              name: updated.name,
              description: updated.description,
              department: updated.department,
              active: updated.active,
            },
          })
          fastify.log.info({ panelId: id }, 'test_panels.updated_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL panel update failed')
        }
      }

      fastify.log.info({ id }, 'test_panels.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }
      fastify.log.error(error as Error, 'test_panels.update_failed')
      reply.code(500).send({ error: 'Failed to update test panel' })
    }
  })

  // POST /test-panels/:panelId/parameters - Add parameter to panel
  fastify.post('/test-panels/:panelId/parameters', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { panelId } = request.params as { panelId: string }
      const parameter = request.body as any

      if (!parameter.parameterCode || !parameter.parameterName) {
        reply.code(400).send({ error: 'Parameter code and name are required' })
        return
      }

      const panel = await db.get(panelId)
      if ((panel as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      const parameters = (panel as any).parameters || []
      
      // Check if parameter already exists
      if (parameters.some((p: any) => p.parameterCode === parameter.parameterCode)) {
        reply.code(409).send({ error: 'Parameter already exists in panel' })
        return
      }

      // Add parameter
      const newParameter = {
        ...parameter,
        sequence: parameter.sequence || parameters.length + 1,
        required: parameter.required !== false,
        active: parameter.active !== false,
      }

      parameters.push(newParameter)

      const updated = {
        ...panel,
        _id: panelId,
        _rev: (panel as any)._rev,
        parameters,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Update PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.testPanelParameter.create({
            data: {
              panelId,
              parameterCode: newParameter.parameterCode,
              parameterName: newParameter.parameterName,
              sequence: newParameter.sequence,
              unit: newParameter.unit,
              refRangeLow: newParameter.refRangeLow,
              refRangeHigh: newParameter.refRangeHigh,
              criticalLow: newParameter.criticalLow,
              criticalHigh: newParameter.criticalHigh,
              defaultValue: newParameter.defaultValue,
              required: newParameter.required,
              active: newParameter.active,
            },
          })
          fastify.log.info({ panelId, parameterCode: newParameter.parameterCode }, 'test_panels.parameter_added_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL parameter creation failed')
        }
      }

      fastify.log.info({ panelId, parameterCode: parameter.parameterCode }, 'test_panels.parameter_added')
      reply.code(201).send({ id: result.id, rev: result.rev, parameter: newParameter })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }
      fastify.log.error(error as Error, 'test_panels.parameter_add_failed')
      reply.code(500).send({ error: 'Failed to add parameter to panel' })
    }
  })

  // PUT /test-panels/:panelId/parameters/:parameterCode - Update parameter
  fastify.put('/test-panels/:panelId/parameters/:parameterCode', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { panelId, parameterCode } = request.params as { panelId: string; parameterCode: string }
      const update = request.body as any

      const panel = await db.get(panelId)
      if ((panel as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      const parameters = (panel as any).parameters || []
      const paramIndex = parameters.findIndex((p: any) => p.parameterCode === parameterCode)

      if (paramIndex === -1) {
        reply.code(404).send({ error: 'Parameter not found in panel' })
        return
      }

      // Update parameter
      parameters[paramIndex] = {
        ...parameters[paramIndex],
        ...update,
        parameterCode, // Don't allow changing the code
      }

      const updated = {
        ...panel,
        _id: panelId,
        _rev: (panel as any)._rev,
        parameters,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Update PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.testPanelParameter.updateMany({
            where: {
              panelId,
              parameterCode,
            },
            data: {
              parameterName: update.parameterName,
              sequence: update.sequence,
              unit: update.unit,
              refRangeLow: update.refRangeLow,
              refRangeHigh: update.refRangeHigh,
              criticalLow: update.criticalLow,
              criticalHigh: update.criticalHigh,
              defaultValue: update.defaultValue,
              required: update.required,
              active: update.active,
            },
          })
          fastify.log.info({ panelId, parameterCode }, 'test_panels.parameter_updated_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL parameter update failed')
        }
      }

      fastify.log.info({ panelId, parameterCode }, 'test_panels.parameter_updated')
      reply.send({ id: result.id, rev: result.rev, parameter: parameters[paramIndex] })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel or parameter not found' })
        return
      }
      fastify.log.error(error as Error, 'test_panels.parameter_update_failed')
      reply.code(500).send({ error: 'Failed to update parameter' })
    }
  })

  // DELETE /test-panels/:panelId/parameters/:parameterCode - Remove parameter from panel
  fastify.delete('/test-panels/:panelId/parameters/:parameterCode', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { panelId, parameterCode } = request.params as { panelId: string; parameterCode: string }

      const panel = await db.get(panelId)
      if ((panel as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      const parameters = (panel as any).parameters || []
      const filtered = parameters.filter((p: any) => p.parameterCode !== parameterCode)

      if (filtered.length === parameters.length) {
        reply.code(404).send({ error: 'Parameter not found in panel' })
        return
      }

      const updated = {
        ...panel,
        _id: panelId,
        _rev: (panel as any)._rev,
        parameters: filtered,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Delete from PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.testPanelParameter.deleteMany({
            where: {
              panelId,
              parameterCode,
            },
          })
          fastify.log.info({ panelId, parameterCode }, 'test_panels.parameter_deleted_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL parameter deletion failed')
        }
      }

      fastify.log.info({ panelId, parameterCode }, 'test_panels.parameter_deleted')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }
      fastify.log.error(error as Error, 'test_panels.parameter_delete_failed')
      reply.code(500).send({ error: 'Failed to delete parameter' })
    }
  })

  // DELETE /test-panels/:id - Delete test panel
  fastify.delete('/test-panels/:id', async (request, reply) => {
    if (!db) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { id } = request.params as { id: string }
      const panel = await db.get(id)

      if ((panel as any).type !== 'testPanel') {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }

      await db.destroy(id, (panel as any)._rev)

      // Delete from PostgreSQL if available
      if (fastify.prisma) {
        try {
          await fastify.prisma.testPanel.delete({
            where: { id },
          })
          fastify.log.info({ panelId: id }, 'test_panels.deleted_postgres')
        } catch (prismaError) {
          fastify.log.warn({ error: prismaError }, 'PostgreSQL panel deletion failed')
        }
      }

      fastify.log.info({ id }, 'test_panels.deleted')
      reply.code(204).send()
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Test panel not found' })
        return
      }
      fastify.log.error(error as Error, 'test_panels.delete_failed')
      reply.code(500).send({ error: 'Failed to delete test panel' })
    }
  })

}

