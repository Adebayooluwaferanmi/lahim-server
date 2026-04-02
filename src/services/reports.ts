import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'
import { randomUUID } from 'crypto'
import { generateHL7Message } from '../lib/formatters/hl7-formatter'
import { generateFHIRDiagnosticReport } from '../lib/formatters/fhir-formatter'
import { sendReportEmail } from '../lib/delivery/email-delivery'
import { sendReportSMS } from '../lib/delivery/sms-delivery'

interface DeliveryRequest {
  methods: ('email' | 'portal' | 'print' | 'api' | 'hl7' | 'sms')[]
  emailAddress?: string
  phoneNumber?: string
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
  formattedContent?: string | object
  contentType?: string
  [key: string]: any // Allow additional properties from CouchDB
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const isWithinDateRange = (value: unknown, startDate?: string, endDate?: string) => {
  if (!value) return !startDate && !endDate

  const isoValue = String(value)
  if (startDate && isoValue < startDate) return false
  if (endDate && isoValue > endDate) return false
  return true
}

const sumBy = (docs: any[], selector: (doc: any) => number) =>
  docs.reduce((sum, doc) => sum + selector(doc), 0)

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'reports')
    await ensureCouchDBDatabase(fastify, 'invoices')
    await ensureCouchDBDatabase(fastify, 'payments')
    await ensureCouchDBDatabase(fastify, 'patient_wallets')
    await ensureCouchDBDatabase(fastify, 'billing_overrides')
    await ensureCouchDBDatabase(fastify, 'financial_transactions')
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

  // GET /reports/:id/download - Download formatted report content (HL7/FHIR)
  fastify.get('/reports/:id/download', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id) as any

      if (doc.type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      if (!doc.formattedContent) {
        reply.code(404).send({ error: 'Formatted content not available for this report' })
        return
      }

      const contentType = doc.contentType || 'application/json'
      const format = doc.format || 'JSON'
      const filename = `${doc.reportNumber || id}.${format.toLowerCase()}`

      reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(typeof doc.formattedContent === 'string' 
          ? doc.formattedContent 
          : JSON.stringify(doc.formattedContent, null, 2))

      fastify.log.debug({ id, format }, 'reports.downloaded')
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Report not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'reports.download_failed')
      reply.code(500).send({ error: 'Failed to download report' })
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
      const format = reportRequest.format || 'PDF'
      
      // Generate formatted content based on format type
      let formattedContent: string | object | undefined
      let contentType = 'application/json'
      
      if (format === 'HL7' || format === 'hl7') {
        // Generate HL7 message
        try {
          const labResultsDb = fastify.couch?.db.use('lab_results')
          if (labResultsDb && reportRequest.patientId && reportRequest.data?.resultIds) {
            // Fetch lab results
            const resultIds = Array.isArray(reportRequest.data.resultIds) 
              ? reportRequest.data.resultIds 
              : [reportRequest.data.resultIds]
            
            const results = await Promise.all(
              resultIds.map((id: string) => labResultsDb.get(id).catch(() => null))
            )
            const validResults = results.filter((r) => r !== null) as any[]
            
            if (validResults.length > 0) {
              formattedContent = generateHL7Message(
                validResults,
                {
                  id: reportRequest.patientId,
                  name: reportRequest.data.patientName,
                  dateOfBirth: reportRequest.data.patientDateOfBirth,
                  gender: reportRequest.data.patientGender,
                  mrn: reportRequest.data.patientMRN,
                },
                {
                  name: reportRequest.facilityName,
                  address: reportRequest.facilityAddress,
                  id: reportRequest.data.facilityId,
                },
                reportRequest.data.orderNumber,
                reportRequest.data.specimenId,
                reportRequest.data.collectedDateTime
              )
              contentType = 'text/plain'
            }
          }
        } catch (hl7Error) {
          fastify.log.warn({ error: hl7Error }, 'Failed to generate HL7 message')
        }
      } else if (format === 'FHIR' || format === 'fhir') {
        // Generate FHIR DiagnosticReport
        try {
          const labResultsDb = fastify.couch?.db.use('lab_results')
          if (labResultsDb && reportRequest.patientId && reportRequest.data?.resultIds) {
            // Fetch lab results
            const resultIds = Array.isArray(reportRequest.data.resultIds) 
              ? reportRequest.data.resultIds 
              : [reportRequest.data.resultIds]
            
            const results = await Promise.all(
              resultIds.map((id: string) => labResultsDb.get(id).catch(() => null))
            )
            const validResults = results.filter((r) => r !== null) as any[]
            
            if (validResults.length > 0) {
              formattedContent = generateFHIRDiagnosticReport(
                validResults,
                {
                  id: reportRequest.patientId,
                  name: reportRequest.data.patientName,
                  dateOfBirth: reportRequest.data.patientDateOfBirth,
                  gender: reportRequest.data.patientGender,
                  mrn: reportRequest.data.patientMRN,
                },
                {
                  name: reportRequest.facilityName,
                  address: reportRequest.facilityAddress,
                  id: reportRequest.data.facilityId,
                },
                reportRequest.data.orderNumber,
                reportRequest.data.specimenId,
                reportRequest.data.collectedDateTime
              )
              contentType = 'application/fhir+json'
            }
          }
        } catch (fhirError) {
          fastify.log.warn({ error: fhirError }, 'Failed to generate FHIR DiagnosticReport')
        }
      }

      const newReport = {
        _id: `report_${Date.now()}_${randomUUID()}`,
        type: 'report',
        reportNumber,
        reportType: reportRequest.reportType,
        status: reportRequest.status || 'Generated',
        format,
        patientId: reportRequest.patientId,
        visitId: reportRequest.visitId,
        generatedOn: now,
        generatedBy: reportRequest.generatedBy || 'system',
        title: reportRequest.title,
        description: reportRequest.description,
        data: reportRequest.data || {},
        formattedContent, // Store formatted content (HL7/FHIR)
        contentType, // Store content type
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

      // Deliver via each requested method
      const deliveries = await Promise.all(
        deliveryReq.methods.map(async (method) => {
          let delivery: any = {
            method,
            deliveredAt: now,
            deliveredTo: deliveryReq.emailAddress || deliveryReq.phoneNumber || deliveryReq.recipientName || 'N/A',
            status: 'pending',
            error: undefined,
          }

          try {
            if (method === 'email') {
              if (!deliveryReq.emailAddress) {
                delivery.status = 'failed'
                delivery.error = 'Email address not provided'
              } else {
                // Get report content for attachment
                let reportContent: string | Buffer | undefined
                if (report.formattedContent) {
                  reportContent = typeof report.formattedContent === 'string'
                    ? Buffer.from(report.formattedContent)
                    : Buffer.from(JSON.stringify(report.formattedContent))
                }

                const emailResult = await sendReportEmail(deliveryReq.emailAddress, report, reportContent)
                if (emailResult.success) {
                  delivery.status = 'success'
                  delivery.deliveredAt = new Date().toISOString()
                } else {
                  delivery.status = 'failed'
                  delivery.error = emailResult.error
                }
              }
            } else if (method === 'sms') {
              if (!deliveryReq.phoneNumber) {
                delivery.status = 'failed'
                delivery.error = 'Phone number not provided'
              } else {
                const smsResult = await sendReportSMS(deliveryReq.phoneNumber, report)
                if (smsResult.success) {
                  delivery.status = 'success'
                  delivery.deliveredAt = new Date().toISOString()
                  delivery.messageId = smsResult.messageId
                } else {
                  delivery.status = 'failed'
                  delivery.error = smsResult.error
                }
              }
            } else if (method === 'print') {
              // Print delivery - would integrate with print queue
              delivery.status = 'success'
              delivery.deliveredAt = new Date().toISOString()
              delivery.deliveredTo = 'Print Queue'
            } else if (method === 'portal') {
              // Portal delivery - mark as available in portal
              delivery.status = 'success'
              delivery.deliveredAt = new Date().toISOString()
              delivery.deliveredTo = 'Patient Portal'
            } else if (method === 'api' || method === 'hl7') {
              // API/HL7 delivery - webhook or direct integration
              delivery.status = 'success'
              delivery.deliveredAt = new Date().toISOString()
              delivery.deliveredTo = 'API/HL7 Interface'
            } else {
              delivery.status = 'failed'
              delivery.error = `Unknown delivery method: ${method}`
            }
          } catch (error: any) {
            delivery.status = 'failed'
            delivery.error = error.message || 'Delivery failed'
            fastify.log.error({ error, method, reportId: id }, 'report.delivery_failed')
          }

          deliveryHistory.push(delivery)
          return delivery
        })
      )

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
      const { reportType = 'summary', startDate, endDate, patientId } = request.query as any

      const invoicesDb = fastify.couch.db.use('invoices')
      const paymentsDb = fastify.couch.db.use('payments')
      const walletsDb = fastify.couch.db.use('patient_wallets')
      const overridesDb = fastify.couch.db.use('billing_overrides')
      const transactionsDb = fastify.couch.db.use('financial_transactions')

      const [invoiceDocs, paymentDocs, walletDocs, overrideDocs, transactionDocs] = await Promise.all([
        invoicesDb.find({
          selector: {
            type: 'invoice',
            ...(patientId ? { patientId } : {}),
          },
          limit: 2000,
        }),
        paymentsDb.find({
          selector: {
            type: 'payment',
            ...(patientId ? { patientId } : {}),
          },
          limit: 2000,
        }),
        walletsDb.find({
          selector: {
            type: 'patientWallet',
            ...(patientId ? { patientId } : {}),
          },
          limit: 2000,
        }),
        overridesDb.find({
          selector: {
            type: 'billingOverride',
            ...(patientId ? { patientId } : {}),
          },
          limit: 2000,
        }),
        transactionsDb.find({
          selector: {
            type: 'financialTransaction',
            ...(patientId ? { patientId } : {}),
          },
          limit: 2000,
        }),
      ])

      const invoices = (invoiceDocs.docs as any[]).filter((invoice) =>
        isWithinDateRange(invoice.billDate || invoice.createdAt, startDate, endDate),
      )
      const payments = (paymentDocs.docs as any[]).filter((payment) =>
        isWithinDateRange(payment.paymentDate || payment.createdAt, startDate, endDate),
      )
      const wallets = (walletDocs.docs as any[]).filter((wallet) =>
        !startDate && !endDate ? true : isWithinDateRange(wallet.updatedAt || wallet.createdAt, startDate, endDate),
      )
      const overrides = (overrideDocs.docs as any[]).filter((override) =>
        !startDate && !endDate
          ? true
          : isWithinDateRange(override.grantedAt || override.createdAt, startDate, endDate),
      )
      const transactions = (transactionDocs.docs as any[]).filter((transaction) =>
        isWithinDateRange(transaction.postedAt || transaction.createdAt, startDate, endDate),
      )

      const totalBilled = sumBy(invoices, (invoice) => toNumber(invoice.total))
      const totalCollected = sumBy(payments, (payment) => toNumber(payment.amount))
      const totalOutstanding = sumBy(invoices, (invoice) => Math.max(toNumber(invoice.balance), 0))
      const totalWalletBalance = sumBy(wallets, (wallet) => toNumber(wallet.balance))
      const activeOverrides = overrides.filter(
        (override) => override.active !== false && override.status !== 'revoked',
      )
      const activeOverrideAmount = sumBy(
        activeOverrides,
        (override) => toNumber(override.approvedAmount ?? override.limitAmount),
      )

      const outstandingByPatient = new Map<string, number>()
      invoices.forEach((invoice) => {
        const currentPatientId = String(invoice.patientId || '')
        if (!currentPatientId) return

        outstandingByPatient.set(
          currentPatientId,
          (outstandingByPatient.get(currentPatientId) || 0) + Math.max(toNumber(invoice.balance), 0),
        )
      })

      let reportData: any = {}

      switch (reportType) {
        case 'summary':
          reportData = {
            summary: {
              totalBilled,
              totalCollected,
              totalOutstanding,
              totalWalletBalance,
              activeOverrideAmount,
              invoiceCount: invoices.length,
              paymentCount: payments.length,
              walletCount: wallets.length,
              activeOverrideCount: activeOverrides.length,
            },
            patientBalances: [...outstandingByPatient.entries()]
              .map(([currentPatientId, balance]) => ({
                patientId: currentPatientId,
                outstandingBalance: balance,
              }))
              .sort((left, right) => right.outstandingBalance - left.outstandingBalance)
              .slice(0, 20),
            recentCollections: payments
              .map((payment) => ({
                id: payment._id,
                patientId: payment.patientId,
                invoiceId: payment.invoiceId,
                paymentDate: payment.paymentDate,
                paymentMethod: payment.paymentMethod,
                amount: toNumber(payment.amount),
                referenceNumber: payment.referenceNumber || '-',
              }))
              .sort((left, right) => String(right.paymentDate || '').localeCompare(String(left.paymentDate || '')))
              .slice(0, 20),
          }
          break

        case 'wallet-balances':
          reportData = {
            summary: {
              totalWalletBalance,
              activeWallets: wallets.filter((wallet) => wallet.status === 'active').length,
              inactiveWallets: wallets.filter((wallet) => wallet.status !== 'active').length,
              averageWalletBalance: wallets.length > 0 ? totalWalletBalance / wallets.length : 0,
            },
            wallets: wallets
              .map((wallet) => ({
                id: wallet._id,
                patientId: wallet.patientId,
                status: wallet.status,
                currency: wallet.currency || 'NGN',
                balance: toNumber(wallet.balance),
                lastFundedAt: wallet.lastFundedAt || '-',
                lastSettledAt: wallet.lastSettledAt || '-',
              }))
              .sort((left, right) => right.balance - left.balance),
            recentWalletActivity: transactions
              .filter((transaction) =>
                ['walletFunding', 'walletSettlement'].includes(String(transaction.transactionType || '')),
              )
              .map((transaction) => ({
                id: transaction._id,
                patientId: transaction.patientId,
                type: transaction.transactionType,
                direction: transaction.direction,
                amount: toNumber(transaction.amount),
                postedAt: transaction.postedAt || transaction.createdAt,
                referenceNumber: transaction.referenceNumber || '-',
              }))
              .sort((left, right) => String(right.postedAt || '').localeCompare(String(left.postedAt || '')))
              .slice(0, 30),
          }
          break

        case 'override-exposure':
          reportData = {
            summary: {
              activeOverrideCount: activeOverrides.length,
              activeOverrideAmount,
              patientsWithOverrides: new Set(activeOverrides.map((override) => String(override.patientId || ''))).size,
            },
            overrides: activeOverrides
              .map((override) => ({
                id: override._id,
                patientId: override.patientId,
                privilegeType: override.privilegeType || 'billing_exception',
                reason: override.reason,
                grantedBy: override.grantedBy,
                approvedAmount: toNumber(override.approvedAmount ?? override.limitAmount),
                outstandingBalance: outstandingByPatient.get(String(override.patientId || '')) || 0,
                expiresAt: override.expiresAt || '-',
                grantedAt: override.grantedAt || override.createdAt,
                status: override.status,
              }))
              .sort((left, right) => right.outstandingBalance - left.outstandingBalance),
          }
          break

        case 'collections':
        case 'payments':
          {
            const byMethod = payments.reduce((acc, payment) => {
              const method = String(payment.paymentMethod || 'unknown')
              acc[method] = (acc[method] || 0) + toNumber(payment.amount)
              return acc
            }, {} as Record<string, number>)

            reportData = {
              summary: {
                totalCollections: totalCollected,
                paymentCount: payments.length,
                averageCollection: payments.length > 0 ? totalCollected / payments.length : 0,
              },
              byMethod: Object.entries(byMethod).map(([method, amount]) => ({
                method,
                amount,
              })),
              payments: payments
                .map((payment) => ({
                  id: payment._id,
                  patientId: payment.patientId,
                  invoiceId: payment.invoiceId,
                  amount: toNumber(payment.amount),
                  paymentDate: payment.paymentDate || payment.createdAt,
                  paymentMethod: payment.paymentMethod,
                  referenceNumber: payment.referenceNumber || '-',
                  receivedBy: payment.receivedBy || '-',
                }))
                .sort((left, right) =>
                  String(right.paymentDate || '').localeCompare(String(left.paymentDate || '')),
                ),
            }
          }
          break

        case 'revenue':
          reportData = {
            summary: {
              totalRevenue: totalBilled,
              invoiceCount: invoices.length,
              averageInvoiceValue: invoices.length > 0 ? totalBilled / invoices.length : 0,
            },
            invoices: invoices
              .map((invoice) => ({
                id: invoice._id,
                patientId: invoice.patientId,
                invoiceNumber: invoice.invoiceNumber || '-',
                billDate: invoice.billDate,
                status: invoice.status,
                total: toNumber(invoice.total),
                paidTotal: toNumber(invoice.paidTotal),
                balance: Math.max(toNumber(invoice.balance), 0),
              }))
              .sort((left, right) => String(right.billDate || '').localeCompare(String(left.billDate || ''))),
          }
          break

        case 'outstanding-balances':
          reportData = {
            summary: {
              totalOutstanding,
              invoiceCount: invoices.filter((invoice) => Math.max(toNumber(invoice.balance), 0) > 0).length,
              patientsWithOutstanding: outstandingByPatient.size,
            },
            invoices: invoices
              .filter((invoice) => Math.max(toNumber(invoice.balance), 0) > 0)
              .map((invoice) => ({
                id: invoice._id,
                patientId: invoice.patientId,
                invoiceNumber: invoice.invoiceNumber || '-',
                billDate: invoice.billDate,
                status: invoice.status,
                total: toNumber(invoice.total),
                paidTotal: toNumber(invoice.paidTotal),
                balance: Math.max(toNumber(invoice.balance), 0),
              }))
              .sort((left, right) => right.balance - left.balance),
          }
          break

        case 'profitability':
          reportData = {
            summary: {
              revenue: totalBilled,
              collections: totalCollected,
              estimatedMargin: totalBilled - totalCollected,
            },
            note: 'Expense modeling is not yet available in this phase. Profitability is presented as billed versus collected.',
          }
          break

        default:
          reply.code(400).send({ error: 'Invalid financial report type' })
          return
      }

      reply.send({
        reportType,
        generatedOn: new Date().toISOString(),
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          patientId: patientId || null,
        },
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

