/**
 * One-time external access: patient-initiated 24h link for doctor (view record) or lab (update labs).
 * Request → Admin approve → Email link → Recipient uses link once.
 */

import { createHash, randomBytes } from 'crypto'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { sendExternalAccessLinkEmail } from '../lib/delivery/email-delivery'

const TOKEN_BYTES = 32
const TOKEN_TTL_HOURS = 24
const EXTERNAL_SOURCE = 'external_one_time'

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function verifyServiceToken(request: FastifyRequest, expectedEnvVar: string): boolean {
  const token = request.headers['x-service-token']
  const expected = process.env[expectedEnvVar] || process.env.PORTAL_SERVICE_TOKEN
  if (!expected || !token) return false
  const t = Array.isArray(token) ? token[0] : token
  return t === expected
}

export default async function externalAccessService(
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) {
  if (!fastify.prisma) {
    fastify.log.warn('external-access: Prisma not available')
    return
  }

  const prisma = fastify.prisma

  // ----- Create request (portal calls with X-Service-Token) -----
  fastify.post<{
    Body: { corePatientId: string; recipientEmail: string; type: 'VIEW_RECORD' | 'UPDATE_LABS'; requestedBy?: string }
  }>('/external-access-requests', async (request, reply) => {
    if (!verifyServiceToken(request, 'EXTERNAL_ACCESS_SERVICE_TOKEN')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const { corePatientId, recipientEmail, type, requestedBy } = request.body || {}
    if (!corePatientId || !recipientEmail || !type) {
      return reply.code(400).send({ error: 'corePatientId, recipientEmail, and type are required' })
    }
    if (type !== 'VIEW_RECORD' && type !== 'UPDATE_LABS') {
      return reply.code(400).send({ error: 'type must be VIEW_RECORD or UPDATE_LABS' })
    }

    const patient = await prisma.patient.findUnique({ where: { patientId: corePatientId } })
    if (!patient) {
      return reply.code(404).send({ error: 'Patient not found' })
    }

    const req = await prisma.externalAccessRequest.create({
      data: {
        patientId: corePatientId,
        requestedBy: requestedBy ?? null,
        recipientEmail: recipientEmail.toLowerCase().trim(),
        type,
        status: 'pending',
      },
    })
    fastify.log.info({ requestId: req.id, patientId: corePatientId, type }, 'external_access.request_created')
    return reply.code(201).send(req)
  })

  // ----- List pending (admin / core frontend) -----
  fastify.get<{ Querystring: { status?: string } }>('/external-access-requests', async (request, reply) => {
    if (!verifyServiceToken(request, 'EXTERNAL_ACCESS_SERVICE_TOKEN')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const status = (request.query?.status as string) || 'pending'
    const list = await prisma.externalAccessRequest.findMany({
      where: status === 'all' ? {} : { status },
      include: { patient: true },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ items: list })
  })

  // ----- Approve: create token, send email -----
  fastify.post<{ Params: { id: string } }>('/external-access-requests/:id/approve', async (request, reply) => {
    if (!verifyServiceToken(request, 'EXTERNAL_ACCESS_SERVICE_TOKEN')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const { id } = request.params
    const req = await prisma.externalAccessRequest.findUnique({ where: { id }, include: { patient: true } })
    if (!req) return reply.code(404).send({ error: 'Request not found' })
    if (req.status !== 'pending') {
      return reply.code(400).send({ error: 'Request is not pending' })
    }

    const rawToken = randomBytes(TOKEN_BYTES).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000)

    const tokenRecord = await prisma.externalAccessToken.create({
      data: {
        requestId: id,
        tokenHash,
        patientId: req.patientId,
        type: req.type,
        expiresAt,
        maxUses: 1,
        useCount: 0,
        recipientEmail: req.recipientEmail,
      },
    })

    await prisma.externalAccessRequest.update({
      where: { id },
      data: { status: 'approved', approvedAt: new Date(), approvedBy: null, tokenId: tokenRecord.id },
    })

    const baseUrl = process.env.EXTERNAL_ACCESS_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3001'
    const link = `${baseUrl}/external-access?token=${rawToken}`

    const emailResult = await sendExternalAccessLinkEmail(
      req.recipientEmail,
      link,
      req.type as 'VIEW_RECORD' | 'UPDATE_LABS',
      TOKEN_TTL_HOURS
    )
    if (!emailResult.success) {
      fastify.log.warn({ error: emailResult.error, requestId: id }, 'external_access.approve_email_failed')
    }

    fastify.log.info({ requestId: id, tokenId: tokenRecord.id }, 'external_access.approved')
    return reply.send({ approved: true, tokenId: tokenRecord.id })
  })

  // ----- Resolve token (one-time use): return patientId + type -----
  async function resolveToken(token: string): Promise<{ patientId: string; type: string; tokenId: string } | null> {
    if (!token) return null
    const tokenHash = hashToken(token)
    const record = await prisma.externalAccessToken.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
    })
    if (!record || record.useCount >= record.maxUses) return null
    return { patientId: record.patientId, type: record.type, tokenId: record.id }
  }

  // GET /external-access/view?token=... — validate token, return patientId/type
  fastify.get<{ Querystring: { token: string } }>('/external-access/view', async (request, reply) => {
    const token = (request.query?.token as string) || ''
    const resolved = await resolveToken(token)
    if (!resolved) {
      return reply.code(404).send({ error: 'Invalid or expired token' })
    }
    return reply.send({ patientId: resolved.patientId, type: resolved.type })
  })

  // GET /external-access/record?token=... — return patient record with source flags (consumes token for view)
  fastify.get<{ Querystring: { token: string } }>('/external-access/record', async (request, reply) => {
    const token = (request.query?.token as string) || ''
    const resolved = await resolveToken(token)
    if (!resolved) {
      return reply.code(404).send({ error: 'Invalid or expired token' })
    }

    const patient = await prisma.patient.findUnique({
      where: { patientId: resolved.patientId },
    })
    if (!patient) return reply.code(404).send({ error: 'Patient not found' })

    const [orders, notes] = await Promise.all([
      prisma.labOrder.findMany({
        where: { patientId: resolved.patientId },
        include: {
          results: true,
        },
        orderBy: { orderedAt: 'desc' },
        take: 100,
      }),
      prisma.externalAccessNote.findMany({
        where: { patientId: resolved.patientId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ])

    const record = {
      patient: {
        patientId: patient.patientId,
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        sex: patient.sex,
      },
      labOrders: orders.map((o: (typeof orders)[number]) => ({
        ...o,
        source: o.source || null,
        results: (o.results || []).map((r: { source?: string; [k: string]: unknown }) => ({
          ...r,
          source: r.source || null,
        })),
      })),
      externalNotes: notes,
      accessType: resolved.type,
    }

    return reply.send(record)
  })

  // POST /external-access/external-note — submit doctor note (token in body or header)
  fastify.post<{
    Body: { token: string; content: string }
  }>('/external-access/external-note', async (request, reply) => {
    const token = (request.body?.token as string) || (request.headers['x-access-token'] as string) || ''
    const content = (request.body?.content as string) || ''
    if (!content.trim()) return reply.code(400).send({ error: 'content is required' })

    const resolved = await resolveToken(token)
    if (!resolved) return reply.code(404).send({ error: 'Invalid or expired token' })
    if (resolved.type !== 'VIEW_RECORD') {
      return reply.code(403).send({ error: 'This access is not for adding notes' })
    }

    await prisma.externalAccessNote.create({
      data: {
        tokenId: resolved.tokenId,
        patientId: resolved.patientId,
        content: content.trim(),
      },
    })

    await prisma.externalAccessToken.update({
      where: { id: resolved.tokenId },
      data: { useCount: { increment: 1 } },
    })

    fastify.log.info({ patientId: resolved.patientId }, 'external_access.note_submitted')
    return reply.code(201).send({ ok: true })
  })

  // POST /external-access/lab-results — submit lab update (token auth)
  fastify.post<{
    Body: {
      token: string
      results: Array<{
        testCodeLoinc: string
        resultType: string
        valueNumber?: number
        valueText?: string
        unitUcum?: string
        refRangeLow?: number
        refRangeHigh?: number
      }>
    }
  }>('/external-access/lab-results', async (request, reply) => {
    const body = request.body as { token?: string; results?: Array<Record<string, unknown>> }
    const token = body?.token || (request.headers['x-access-token'] as string) || ''
    const results = body?.results
    if (!Array.isArray(results) || results.length === 0) {
      return reply.code(400).send({ error: 'results array is required' })
    }

    const resolved = await resolveToken(token)
    if (!resolved) return reply.code(404).send({ error: 'Invalid or expired token' })
    if (resolved.type !== 'UPDATE_LABS') {
      return reply.code(403).send({ error: 'This access is not for lab results' })
    }

    const testCatalogCodes = await prisma.testCatalog.findMany({
      where: { code: { in: results.map((r) => r.testCodeLoinc as string).filter(Boolean) } },
      select: { code: true },
    })
    const validCodes = new Set(testCatalogCodes.map((c: (typeof testCatalogCodes)[number]) => c.code))
    const orderIds: string[] = []

    for (const r of results) {
      const code = r.testCodeLoinc as string
      if (!code || !validCodes.has(code)) continue
      const order = await prisma.labOrder.create({
        data: {
          patientId: resolved.patientId,
          testCodeLoinc: code,
          isPanel: false,
          status: 'completed',
          source: EXTERNAL_SOURCE,
        },
      })
      await prisma.labResult.create({
        data: {
          orderId: order.id,
          analyteCodeLoinc: code,
          resultType: (r.resultType as string) || 'numeric',
          valueNumber: r.valueNumber as number | undefined,
          valueText: r.valueText as string | undefined,
          unitUcum: r.unitUcum as string | undefined,
          refRangeLow: r.refRangeLow as number | undefined,
          refRangeHigh: r.refRangeHigh as number | undefined,
          finalizedAt: new Date(),
          source: EXTERNAL_SOURCE,
          flags: [],
        },
      })
      orderIds.push(order.id)
    }

    await prisma.externalAccessToken.update({
      where: { id: resolved.tokenId },
      data: { useCount: { increment: 1 } },
    })

    fastify.log.info({ patientId: resolved.patientId, orderIds }, 'external_access.lab_results_submitted')
    return reply.code(201).send({ ok: true, orderIds })
  })
}
