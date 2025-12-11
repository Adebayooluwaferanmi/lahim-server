import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import PDFDocument from 'pdfkit'

/**
 * PDF Report Generation Service
 * Generates CLIA-compliant laboratory reports in PDF format
 */

interface ReportData {
  patientId: string
  patientName?: string
  patientDOB?: string
  patientGender?: string
  reportNumber?: string
  reportDate: string
  facilityName?: string
  facilityAddress?: string
  results: Array<{
    testCode: string
    testName: string
    resultType: 'numeric' | 'coded' | 'text' | 'microbiology'
    value?: number | string
    unit?: string
    referenceRange?: { low?: number; high?: number }
    flags?: string[]
    reportedDateTime?: string
  }>
  signedBy?: string
  signedDate?: string
  comments?: string
}

/**
 * Generate PDF report buffer
 */
function generatePDFReport(reportData: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      })

      const buffers: Buffer[] = []
      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers)
        resolve(pdfBuffer)
      })
      doc.on('error', reject)

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text('LABORATORY REPORT', { align: 'center' })
      doc.moveDown(0.5)

      if (reportData.facilityName) {
        doc.fontSize(12).font('Helvetica').text(reportData.facilityName, { align: 'center' })
      }
      if (reportData.facilityAddress) {
        doc.fontSize(10).text(reportData.facilityAddress, { align: 'center' })
      }
      doc.moveDown(1)

      // Patient Information
      doc.fontSize(12).font('Helvetica-Bold').text('PATIENT INFORMATION', { underline: true })
      doc.moveDown(0.3)
      doc.fontSize(10).font('Helvetica')

      const patientInfo = []
      if (reportData.patientName) patientInfo.push(`Name: ${reportData.patientName}`)
      if (reportData.patientId) patientInfo.push(`Patient ID: ${reportData.patientId}`)
      if (reportData.patientDOB) patientInfo.push(`Date of Birth: ${new Date(reportData.patientDOB).toLocaleDateString()}`)
      if (reportData.patientGender) patientInfo.push(`Gender: ${reportData.patientGender}`)

      patientInfo.forEach((info) => {
        doc.text(info)
      })

      doc.moveDown(0.5)
      if (reportData.reportNumber) {
        doc.text(`Report Number: ${reportData.reportNumber}`)
      }
      doc.text(`Report Date: ${new Date(reportData.reportDate).toLocaleString()}`)
      doc.moveDown(1)

      // Results Table
      doc.fontSize(12).font('Helvetica-Bold').text('LABORATORY RESULTS', { underline: true })
      doc.moveDown(0.5)

      // Table header
      const tableTop = doc.y
      const tableLeft = 50
      const colWidths = { test: 200, result: 100, unit: 60, range: 120, flag: 60 }
      let currentY = tableTop

      doc.fontSize(10).font('Helvetica-Bold')
      doc.text('Test', tableLeft, currentY)
      doc.text('Result', tableLeft + colWidths.test, currentY)
      doc.text('Unit', tableLeft + colWidths.test + colWidths.result, currentY)
      doc.text('Reference Range', tableLeft + colWidths.test + colWidths.result + colWidths.unit, currentY)
      doc.text('Flag', tableLeft + colWidths.test + colWidths.result + colWidths.unit + colWidths.range, currentY)

      currentY += 20
      doc.moveTo(tableLeft, currentY).lineTo(tableLeft + 600, currentY).stroke()
      currentY += 5

      // Results rows
      doc.fontSize(9).font('Helvetica')
      reportData.results.forEach((result) => {
        if (currentY > 700) {
          // New page if needed
          doc.addPage()
          currentY = 50
        }

        const testName = result.testName || result.testCode
        const resultValue =
          result.resultType === 'numeric'
            ? result.value?.toString() || '-'
            : result.resultType === 'coded'
            ? result.value?.toString() || '-'
            : result.value?.toString() || '-'

        const unit = result.unit || '-'
        const refRange = result.referenceRange
          ? `${result.referenceRange.low !== undefined ? result.referenceRange.low : ''} - ${
              result.referenceRange.high !== undefined ? result.referenceRange.high : ''
            }`
          : '-'
        const flags = result.flags && result.flags.length > 0 ? result.flags.join(', ') : '-'

        doc.text(testName, tableLeft, currentY, { width: colWidths.test, ellipsis: true })
        doc.text(resultValue, tableLeft + colWidths.test, currentY, { width: colWidths.result })
        doc.text(unit, tableLeft + colWidths.test + colWidths.result, currentY, { width: colWidths.unit })
        doc.text(refRange, tableLeft + colWidths.test + colWidths.result + colWidths.unit, currentY, {
          width: colWidths.range,
        })
        doc.text(flags, tableLeft + colWidths.test + colWidths.result + colWidths.unit + colWidths.range, currentY, {
          width: colWidths.flag,
        })

        currentY += 15
      })

      doc.moveDown(1)

      // Comments
      if (reportData.comments) {
        doc.fontSize(10).font('Helvetica-Bold').text('COMMENTS', { underline: true })
        doc.moveDown(0.3)
        doc.fontSize(9).font('Helvetica').text(reportData.comments)
        doc.moveDown(1)
      }

      // Footer
      const pageHeight = doc.page.height
      const footerY = pageHeight - 100

      doc.fontSize(8).font('Helvetica').text('This report is for authorized use only.', 50, footerY, { align: 'center' })

      if (reportData.signedBy) {
        doc.moveDown(0.5)
        doc.text(`Signed by: ${reportData.signedBy}`, { align: 'center' })
      }
      if (reportData.signedDate) {
        doc.text(`Date: ${new Date(reportData.signedDate).toLocaleString()}`, { align: 'center' })
      }

      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('PDF Reports service: CouchDB not available - endpoints will return errors')
    return
  }

  const reportsDb = fastify.couch.db.use('reports')
  const labResultsDb = fastify.couch.db.use('lab_results')

  // POST /reports/:id/generate-pdf - Generate PDF report
  fastify.post('/reports/:id/generate-pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { includeComments } = request.body as { format?: string; includeComments?: boolean }

      // Get report
      const reportDoc = await reportsDb.get(id)
      const report = reportDoc as any

      if (report.type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      // Get lab results for this report
      const resultIds = report.resultIds || []
      const results: any[] = []

      for (const resultId of resultIds) {
        try {
          const resultDoc = await labResultsDb.get(resultId)
          results.push(resultDoc)
        } catch (err) {
          fastify.log.warn({ resultId, error: err }, 'Failed to fetch result for PDF')
        }
      }

      // Build report data
      const reportData: ReportData = {
        patientId: report.patientId || '',
        patientName: report.patientName,
        patientDOB: report.patientDOB,
        patientGender: report.patientGender,
        reportNumber: report.reportNumber || report._id,
        reportDate: report.generatedOn || report.createdAt || new Date().toISOString(),
        facilityName: report.facilityName || 'Laboratory',
        facilityAddress: report.facilityAddress,
        results: results.map((r: any) => ({
          testCode: r.testCode?.coding?.[0]?.code || r.testCode || '',
          testName: r.testCode?.coding?.[0]?.display || r.testName || '',
          resultType: r.resultType || 'numeric',
          value: r.numericValue || r.codedValue?.display || r.textValue || '',
          unit: r.unit || r.unitUcum || '',
          referenceRange: r.referenceRange,
          flags: r.flags || [],
          reportedDateTime: r.reportedDateTime || r.createdAt,
        })),
        signedBy: report.signedBy,
        signedDate: report.signedDate || report.signedOn,
        comments: includeComments ? report.comments : undefined,
      }

      // Generate PDF
      const pdfBuffer = await generatePDFReport(reportData)

      // Set response headers
      reply.type('application/pdf')
      reply.header('Content-Disposition', `attachment; filename="report-${report.reportNumber || id}.pdf"`)

      fastify.log.info({ reportId: id, resultCount: results.length }, 'pdf_report.generated')
      reply.send(pdfBuffer)
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error }, 'pdf_report.generate_failed')
      reply.code(500).send({ error: 'Failed to generate PDF report' })
    }
  })

  // GET /reports/:id/pdf - Get PDF report (same as generate but GET)
  fastify.get('/reports/:id/pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      // Get report
      const reportDoc = await reportsDb.get(id)
      const report = reportDoc as any

      if (report.type !== 'report') {
        reply.code(404).send({ error: 'Report not found' })
        return
      }

      // Get lab results
      const resultIds = report.resultIds || []
      const results: any[] = []

      for (const resultId of resultIds) {
        try {
          const resultDoc = await labResultsDb.get(resultId)
          results.push(resultDoc)
        } catch (err) {
          fastify.log.warn({ resultId, error: err }, 'Failed to fetch result for PDF')
        }
      }

      // Build report data
      const reportData: ReportData = {
        patientId: report.patientId || '',
        patientName: report.patientName,
        patientDOB: report.patientDOB,
        patientGender: report.patientGender,
        reportNumber: report.reportNumber || report._id,
        reportDate: report.generatedOn || report.createdAt || new Date().toISOString(),
        facilityName: report.facilityName || 'Laboratory',
        facilityAddress: report.facilityAddress,
        results: results.map((r: any) => ({
          testCode: r.testCode?.coding?.[0]?.code || r.testCode || '',
          testName: r.testCode?.coding?.[0]?.display || r.testName || '',
          resultType: r.resultType || 'numeric',
          value: r.numericValue || r.codedValue?.display || r.textValue || '',
          unit: r.unit || r.unitUcum || '',
          referenceRange: r.referenceRange,
          flags: r.flags || [],
          reportedDateTime: r.reportedDateTime || r.createdAt,
        })),
        signedBy: report.signedBy,
        signedDate: report.signedDate || report.signedOn,
      }

      // Generate PDF
      const pdfBuffer = await generatePDFReport(reportData)

      // Set response headers
      reply.type('application/pdf')
      reply.header('Content-Disposition', `inline; filename="report-${report.reportNumber || id}.pdf"`)

      fastify.log.info({ reportId: id }, 'pdf_report.served')
      reply.send(pdfBuffer)
    } catch (error: unknown) {
      fastify.log.error({ error: error as Error }, 'pdf_report.serve_failed')
      reply.code(500).send({ error: 'Failed to serve PDF report' })
    }
  })
}

