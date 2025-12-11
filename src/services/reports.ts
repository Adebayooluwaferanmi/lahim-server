import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { randomUUID } from 'crypto'

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

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'reports')
  }

  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Reports service: CouchDB not available - endpoints will return errors')
    return
  }

  const db = fastify.couch.db.use('reports')
  const cache = createMetricsCacheHelper(fastify, 'reports')

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'reports',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'generatedOn'] }, name: 'type-generatedOn-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'reportType'] }, name: 'type-reportType-index' },
      { index: { fields: ['generatedOn'] }, name: 'generatedOn-index' },
    ],
    'Reports'
  )

  // Helper function to generate report number
  const generateReportNumber = async (reportType: string): Promise<string> => {
    const year = new Date().getFullYear()
    const prefix = `RPT-${year}-${reportType.substring(0, 3).toUpperCase()}-`
    
    try {
      const result = await db.find({
        selector: {
          type: 'report',
          reportType,
          reportNumber: { $regex: `^${prefix}` },
        },
        limit: 1,
        sort: [{ reportNumber: 'desc' }],
      })

      if (result.docs.length > 0) {
        const lastNumber = (result.docs[0] as any).reportNumber
        const lastSeq = parseInt(lastNumber.replace(prefix, ''), 10) || 0
        return `${prefix}${String(lastSeq + 1).padStart(6, '0')}`
      }
    } catch (error) {
      fastify.log.warn({ error }, 'Error generating report number, starting from 1')
    }

    return `${prefix}000001`
  }

  // GET /reports - List reports (with caching)
  fastify.get('/reports', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, patientId, status, reportType, startDate, endDate } = request.query as any
      
      // Create cache key
      const cacheKey = `reports:${patientId || 'all'}:${status || 'all'}:${reportType || 'all'}:${startDate || 'all'}:${endDate || 'all'}:${limit}:${skip}`
      
      // Try to get from cache
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'reports.list_cache_hit')
        return reply.send(cached)
      }

      const selector: any = { type: 'report' }

      if (patientId) selector.patientId = patientId
      if (status) selector.status = status
      if (reportType) selector.reportType = reportType
      if (startDate || endDate) {
        selector.generatedOn = {}
        if (startDate) selector.generatedOn.$gte = startDate
        if (endDate) selector.generatedOn.$lte = endDate
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ generatedOn: 'desc' }],
      })

      const response = { reports: result.docs, count: result.docs.length }
      
      // Cache for 5 minutes (reports don't change frequently)
      await cache.set(cacheKey, response, 300)

      fastify.log.info({ count: result.docs.length }, 'reports.list')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.list_failed')
      reply.code(500).send({ error: 'Failed to list reports' })
    }
  })

  // GET /reports/:id - Get single report (with caching)
  fastify.get('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      
      // Try cache first
      const cacheKey = `reports:${id}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'reports.get_cache_hit')
        return reply.send(cached)
      }

      const doc = await db.get(id)

      if ((doc as any).type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      // Cache for 10 minutes (reports are read-only after generation)
      await cache.set(cacheKey, doc, 600)

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

      if (!reportRequest.reportType) {
        reply.code(400).send({ error: 'Report type is required' })
        return
      }

      const now = new Date().toISOString()
      const reportNumber = await generateReportNumber(reportRequest.reportType)

      const newReport = {
        _id: `report_${Date.now()}_${randomUUID()}`,
        type: 'report',
        reportNumber,
        reportType: reportRequest.reportType,
        status: reportRequest.status || 'Generated',
        format: reportRequest.format || 'PDF',
        patientId: reportRequest.patientId,
        visitId: reportRequest.visitId,
        generatedOn: now,
        generatedBy: reportRequest.generatedBy || 'system',
        title: reportRequest.title,
        description: reportRequest.description,
        data: reportRequest.data || {},
        deliveryMethods: reportRequest.deliveryMethods || [],
        deliveryStatus: reportRequest.deliveryStatus,
        deliveryHistory: reportRequest.deliveryHistory || [],
        facilityName: reportRequest.facilityName,
        facilityAddress: reportRequest.facilityAddress,
        signedBy: reportRequest.signedBy,
        signedDate: reportRequest.signedDate,
        comments: reportRequest.comments,
        createdAt: now,
        updatedAt: now,
      }

      const result = await db.insert(newReport)

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('report.generated', {
        id: result.id,
        reportNumber,
        reportType: reportRequest.reportType,
        patientId: reportRequest.patientId,
      })

      // Invalidate cache
      await cache.deletePattern('reports:*')

      fastify.log.info({ id: result.id, reportNumber, reportType: reportRequest.reportType }, 'reports.generated')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.generate_failed')
      reply.code(500).send({ error: 'Failed to generate report' })
    }
  })

  // PUT /reports/:id - Update report
  fastify.put('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id)
      if ((existing as any).type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)
      
      // Invalidate cache
      await cache.deletePattern('reports:*')
      await cache.delete(`reports:${id}`)

      fastify.log.info({ id }, 'reports.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Report not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'reports.update_failed')
      reply.code(500).send({ error: 'Failed to update report' })
    }
  })

  // DELETE /reports/:id - Delete report
  fastify.delete('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      await db.destroy(id, (doc as any)._rev)
      
      // Invalidate cache
      await cache.deletePattern('reports:*')
      await cache.delete(`reports:${id}`)
      fastify.log.info({ id }, 'reports.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Report not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'reports.delete_failed')
      reply.code(500).send({ error: 'Failed to delete report' })
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
        let delivery: any = {
          method,
          deliveredAt: now,
          deliveredTo: deliveryReq.emailAddress || deliveryReq.recipientName || 'N/A',
          status: 'success',
          error: undefined,
        }

        // Add specific logic for each method if needed
        if (method === 'email' && !deliveryReq.emailAddress) {
          delivery = {
            ...delivery,
            status: 'failed',
            error: 'Email address not provided',
          }
        }
        // For 'print', 'portal', 'api', 'hl7' we assume success for now

        deliveryHistory.push(delivery)
        return delivery
      })

      report.deliveryMethods = deliveryReq.methods
      report.deliveryStatus = deliveries.some((d: any) => d.status === 'failed') ? 'failed' : 'delivered'
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

  // GET /reports/analytics - Get analytics data
  fastify.get('/reports/analytics', async (request, reply) => {
    try {
      const { startDate, endDate, reportType } = request.query as any

      // Get data from various services for analytics
      const visitsDb = fastify.couch.db.use('visits')
      const invoicesDb = fastify.couch.db.use('invoices')
      const incidentsDb = fastify.couch.db.use('incidents')
      const imagingDb = fastify.couch.db.use('imaging')

      const analytics: any = {
        period: {
          startDate: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          endDate: endDate || new Date().toISOString(),
        },
        visits: {},
        financial: {},
        incidents: {},
        imaging: {},
      }

      // Visit analytics
      try {
        const visitSelector: any = { type: 'visit' }
        if (startDate || endDate) {
          visitSelector.startDate = {}
          if (startDate) visitSelector.startDate.$gte = startDate
          if (endDate) visitSelector.startDate.$lte = endDate
        }
        const visitsResult = await visitsDb.find({ selector: visitSelector })
        const visits = visitsResult.docs

        analytics.visits = {
          total: visits.length,
          byType: visits.reduce((acc: any, v: any) => {
            acc[v.visitType] = (acc[v.visitType] || 0) + 1
            return acc
          }, {}),
          byStatus: visits.reduce((acc: any, v: any) => {
            acc[v.status] = (acc[v.status] || 0) + 1
            return acc
          }, {}),
        }
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to get visit analytics')
      }

      // Financial analytics
      try {
        const invoiceSelector: any = { type: 'invoice' }
        if (startDate || endDate) {
          invoiceSelector.billDate = {}
          if (startDate) invoiceSelector.billDate.$gte = startDate
          if (endDate) invoiceSelector.billDate.$lte = endDate
        }
        const invoicesResult = await invoicesDb.find({ selector: invoiceSelector })
        const invoices = invoicesResult.docs

        analytics.financial = {
          totalInvoices: invoices.length,
          totalRevenue: invoices.reduce((sum: number, inv: any) => sum + (inv.total || 0), 0),
          totalPaid: invoices.reduce((sum: number, inv: any) => sum + (inv.paidTotal || 0), 0),
          totalOutstanding: invoices.reduce((sum: number, inv: any) => sum + (inv.balance || 0), 0),
          byStatus: invoices.reduce((acc: any, inv: any) => {
            acc[inv.status] = (acc[inv.status] || 0) + 1
            return acc
          }, {}),
        }
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to get financial analytics')
      }

      // Incident analytics
      try {
        const incidentSelector: any = { type: 'incident' }
        if (startDate || endDate) {
          incidentSelector.reportedDate = {}
          if (startDate) incidentSelector.reportedDate.$gte = startDate
          if (endDate) incidentSelector.reportedDate.$lte = endDate
        }
        const incidentsResult = await incidentsDb.find({ selector: incidentSelector })
        const incidents = incidentsResult.docs

        analytics.incidents = {
          total: incidents.length,
          bySeverity: incidents.reduce((acc: any, inc: any) => {
            acc[inc.severity] = (acc[inc.severity] || 0) + 1
            return acc
          }, {}),
          byCategory: incidents.reduce((acc: any, inc: any) => {
            acc[inc.category] = (acc[inc.category] || 0) + 1
            return acc
          }, {}),
          byStatus: incidents.reduce((acc: any, inc: any) => {
            acc[inc.status] = (acc[inc.status] || 0) + 1
            return acc
          }, {}),
        }
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to get incident analytics')
      }

      // Imaging analytics
      try {
        const imagingSelector: any = { type: 'imaging' }
        if (startDate || endDate) {
          imagingSelector.requestedDate = {}
          if (startDate) imagingSelector.requestedDate.$gte = startDate
          if (endDate) imagingSelector.requestedDate.$lte = endDate
        }
        const imagingResult = await imagingDb.find({ selector: imagingSelector })
        const imaging = imagingResult.docs

        analytics.imaging = {
          total: imaging.length,
          byStatus: imaging.reduce((acc: any, img: any) => {
            acc[img.status] = (acc[img.status] || 0) + 1
            return acc
          }, {}),
        }
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to get imaging analytics')
      }

      fastify.log.info({ reportType }, 'reports.analytics.generated')
      reply.send(analytics)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.analytics.failed')
      reply.code(500).send({ error: 'Failed to generate analytics' })
    }
  })

  // ========== ADMINISTRATIVE REPORTS ==========

  // GET /reports/administrative - Generate administrative reports
  fastify.get('/reports/administrative', async (request, reply) => {
    try {
      const { reportType, startDate, endDate: _endDate, department: _department } = request.query as any

      // Get data from various sources based on report type
      let reportData: any = {}

      switch (reportType) {
        case 'patient-demographics':
          // Get patient demographics
          const patientsDb = fastify.couch.db.use('patients')
          const patientsResult = await patientsDb.find({
            selector: { type: 'patient' },
            limit: 1000,
          })
          reportData = {
            totalPatients: patientsResult.docs.length,
            byGender: {},
            byAgeGroup: {},
            byLocation: {},
          }
          // Process demographics...
          break

        case 'appointment-statistics':
          const appointmentsDb = fastify.couch.db.use('appointments')
          const appointmentSelector: any = {
            type: 'appointment',
          }
          if (startDate) {
            appointmentSelector.startDateTime = { $gte: startDate }
          }
          const appointmentsResult = await appointmentsDb.find({
            selector: appointmentSelector,
            limit: 1000,
          })
          reportData = {
            totalAppointments: appointmentsResult.docs.length,
            byType: {},
            byStatus: {},
            byDepartment: {},
          }
          break

        case 'resource-utilization':
          reportData = {
            bedUtilization: {},
            equipmentUtilization: {},
            staffUtilization: {},
          }
          break

        default:
          reply.code(400).send({ error: 'Invalid administrative report type' })
          return
      }

      reply.send({
        reportType,
        generatedOn: new Date().toISOString(),
        data: reportData,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.administrative_failed')
      reply.code(500).send({ error: 'Failed to generate administrative report' })
    }
  })

  // ========== FINANCIAL REPORTS ==========

  // GET /reports/financial - Generate financial reports
  fastify.get('/reports/financial', async (request, reply) => {
    try {
      const { reportType, startDate, endDate } = request.query as any

      const invoicesDb = fastify.couch.db.use('invoices')
      const paymentsDb = fastify.couch.db.use('payments')
      // const chargesDb = fastify.couch.db.use('charges') // Reserved for future use

      let reportData: any = {}

      switch (reportType) {
        case 'revenue':
          const revenueSelector: any = {
            type: 'invoice',
          }
          if (startDate && endDate) {
            revenueSelector.billDate = { $gte: startDate, $lte: endDate }
          }
          const invoicesResult = await invoicesDb.find({
            selector: revenueSelector,
            limit: 1000,
          })
          const totalRevenue = invoicesResult.docs.reduce((sum: number, inv: any) => {
            return sum + (inv.totalAmount || 0)
          }, 0)
          reportData = {
            totalRevenue,
            invoiceCount: invoicesResult.docs.length,
            byDepartment: {},
            byService: {},
          }
          break

        case 'payments':
          const paymentSelector: any = {
            type: 'payment',
          }
          if (startDate && endDate) {
            paymentSelector.paymentDate = { $gte: startDate, $lte: endDate }
          }
          const paymentsResult = await paymentsDb.find({
            selector: paymentSelector,
            limit: 1000,
          })
          const totalPayments = paymentsResult.docs.reduce((sum: number, pay: any) => {
            return sum + (pay.amount || 0)
          }, 0)
          reportData = {
            totalPayments,
            paymentCount: paymentsResult.docs.length,
            byMethod: {},
            byDate: {},
          }
          break

        case 'outstanding-balances':
          const outstandingInvoices = await invoicesDb.find({
            selector: {
              type: 'invoice',
              status: { $ne: 'Paid' },
            },
            limit: 1000,
          })
          const totalOutstanding = outstandingInvoices.docs.reduce((sum: number, inv: any) => {
            return sum + ((inv.totalAmount || 0) - (inv.paidAmount || 0))
          }, 0)
          reportData = {
            totalOutstanding,
            invoiceCount: outstandingInvoices.docs.length,
            byAge: {},
            byPatient: {},
          }
          break

        case 'profitability':
          // Calculate revenue vs expenses
          reportData = {
            revenue: {},
            expenses: {},
            profit: {},
            margin: {},
          }
          break

        default:
          reply.code(400).send({ error: 'Invalid financial report type' })
          return
      }

      reply.send({
        reportType,
        generatedOn: new Date().toISOString(),
        data: reportData,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'reports.financial_failed')
      reply.code(500).send({ error: 'Failed to generate financial report' })
    }
  })

  // ========== CUSTOM REPORT BUILDER ==========

  // POST /reports/custom - Generate custom report
  fastify.post('/reports/custom', async (request, reply) => {
    try {
      // Check if CouchDB is available
      if (!fastify.couchAvailable || !fastify.couch) {
        reply.code(503).send({ 
          error: 'Database service unavailable',
          message: 'CouchDB is not available. Please check the database connection.'
        })
        return
      }

      const { fields, filters, format, title } = request.body as any

      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        reply.code(400).send({ error: 'Fields are required', message: 'At least one field must be selected' })
        return
      }

      // Build query based on selected fields and filters
      const query: any = {}
      if (filters) {
        Object.assign(query, filters)
      }

      // Fetch data from appropriate databases based on fields
      const dataSources: any = {}
      
      if (fields.some((f: string) => f.startsWith('patient.'))) {
        try {
          await ensureCouchDBDatabase(fastify, 'patients')
          const patientsDb = fastify.couch!.db.use('patients')
          const patientsResult = await patientsDb.find({
            selector: { type: 'patient', ...query },
            limit: 1000,
          })
          dataSources.patients = patientsResult.docs || []
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to fetch patients data for custom report')
          dataSources.patients = []
        }
      }

      if (fields.some((f: string) => f.startsWith('visit.'))) {
        try {
          await ensureCouchDBDatabase(fastify, 'visits')
          const visitsDb = fastify.couch!.db.use('visits')
          const visitsResult = await visitsDb.find({
            selector: { type: 'visit', ...query },
            limit: 1000,
          })
          dataSources.visits = visitsResult.docs || []
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to fetch visits data for custom report')
          dataSources.visits = []
        }
      }

      if (fields.some((f: string) => f.startsWith('billing.'))) {
        try {
          await ensureCouchDBDatabase(fastify, 'invoices')
          const invoicesDb = fastify.couch!.db.use('invoices')
          const invoicesResult = await invoicesDb.find({
            selector: { type: 'invoice', ...query },
            limit: 1000,
          })
          dataSources.billing = invoicesResult.docs || []
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to fetch billing data for custom report')
          dataSources.billing = []
        }
      }

      // Ensure reports database exists before inserting
      try {
        await ensureCouchDBDatabase(fastify, 'reports')
      } catch (error) {
        fastify.log.error({ error }, 'Failed to ensure reports database')
        throw new Error('Failed to create reports database. Please check CouchDB connection.')
      }

      // Generate report number
      const now = new Date().toISOString()
      let reportNumber: string
      try {
        reportNumber = await generateReportNumber('CUSTOM')
      } catch (error) {
        // If report number generation fails, use a simple fallback
        fastify.log.warn({ error }, 'Failed to generate report number, using fallback')
        reportNumber = `RPT-${new Date().getFullYear()}-CUS-${Date.now()}`
      }

      const customReport = {
        _id: `report_${Date.now()}_${randomUUID()}`,
        type: 'report',
        reportNumber,
        reportType: 'Custom',
        status: 'Generated',
        format: format || 'JSON',
        title: title || 'Custom Report',
        generatedOn: now,
        generatedBy: 'system',
        fields,
        filters,
        data: dataSources,
        createdAt: now,
        updatedAt: now,
      }

      // Re-get the db reference after ensuring it exists
      const reportsDb = fastify.couch!.db.use('reports')
      const result = await reportsDb.insert(customReport)

      fastify.log.info({ id: result.id, reportNumber }, 'reports.custom_generated')
      reply.code(201).send({ id: result.id, rev: result.rev, ...customReport })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      fastify.log.error({ error: errorMessage, stack: error instanceof Error ? error.stack : undefined }, 'reports.custom_failed')
      reply.code(500).send({ 
        error: 'Failed to generate custom report',
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.stack : String(error)) : undefined
      })
    }
  })

}

