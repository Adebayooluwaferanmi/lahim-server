import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { nextCallback } from 'fastify-plugin'

interface DeliveryRequest {
  methods: ('email' | 'portal' | 'print' | 'api' | 'hl7')[]
  emailAddress?: string
  recipientName?: string
}

interface Report {
  _id?: string
  _rev?: string
  type: string
  deliveryMethods?: string[]
  deliveryStatus?: string
  deliveryHistory?: any[]
  updatedAt?: string
}

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: nextCallback,
) => {
  const db = fastify.couch.db.use('reports')

  // GET /reports - List reports
  fastify.get('/reports', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, patientId, status } = request.query as any
      const selector: any = { type: 'report' }

      if (patientId) selector.patientId = patientId
      if (status) selector.status = status

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ generatedOn: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'reports.list')
      reply.send({ reports: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.list_failed')
      reply.code(500).send({ error: 'Failed to list reports' })
    }
  })

  // GET /reports/:id - Get single report
  fastify.get('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      fastify.log.debug({ id }, 'reports.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Report not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'reports.get_failed')
      reply.code(500).send({ error: 'Failed to get report' })
    }
  })

  // POST /reports - Generate report
  fastify.post('/reports', async (request, reply) => {
    try {
      const reportRequest = request.body as any

      if (!reportRequest.patientId || !reportRequest.reportType) {
        reply.code(400).send({ error: 'Patient ID and report type are required' })
        return
      }

      const now = new Date().toISOString()
      const newReport = {
        ...reportRequest,
        type: 'report',
        status: 'generated',
        generatedOn: now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newReport)

      fastify.log.info({ id: result.id, patientId: reportRequest.patientId, reportType: reportRequest.reportType }, 'reports.generated')
      reply.code(201).send({ id: result.id, rev: result.rev, ...newReport })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.generate_failed')
      reply.code(500).send({ error: 'Failed to generate report' })
    }
  })

  // POST /reports/:id/deliver - Deliver report via multiple channels
  fastify.post('/reports/:id/deliver', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const deliveryReq = request.body as DeliveryRequest

      if (!deliveryReq.methods || deliveryReq.methods.length === 0) {
        reply.code(400).send({ error: 'At least one delivery method is required' })
        return
      }

      const doc = await db.get(id)
      const report = doc as Report

      const now = new Date().toISOString()
      const deliveryHistory = report.deliveryHistory || []

      // Simulate delivery for each method
      const deliveries = deliveryReq.methods.map((method) => {
        // In a real implementation, this would actually send emails, print, etc.
        const delivery = {
          method,
          deliveredAt: now,
          deliveredTo: deliveryReq.emailAddress || deliveryReq.recipientName || 'N/A',
          status: 'success' as const,
          error: undefined,
        }

        // Add specific logic for each method if needed
        if (method === 'email' && !deliveryReq.emailAddress) {
          delivery.status = 'failed'
          delivery.error = 'Email address not provided'
        }
        // For 'print', 'portal', 'api', 'hl7' we assume success for now

        deliveryHistory.push(delivery)
        return delivery
      })

      report.deliveryMethods = deliveryReq.methods
      report.deliveryStatus = deliveries.some((d) => d.status === 'failed') ? 'failed' : 'delivered'
      report.deliveryHistory = deliveryHistory
      report.updatedAt = now

      const response = await db.insert(report)

      fastify.log.info({ id, methods: deliveryReq.methods }, 'reports.delivered')
      reply.send({
        report: { ...report, _id: response.id, _rev: response.rev },
        deliveries,
      })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Report not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'reports.deliver_failed')
      reply.code(500).send({ error: 'Failed to deliver report' })
    }
  })

  next()
}

