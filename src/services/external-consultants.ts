import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyError, FastifyInstance } from 'fastify'

type FastifyTypedInstance = FastifyInstance<Server, IncomingMessage, ServerResponse>

interface InviteConsultantPayload {
  email: string
  firstName?: string
  lastName?: string
  specialty?: string
  organization?: string
  expiresInHours?: number
}

export default (
  fastify: FastifyTypedInstance,
  _opts: {},
  next: (err?: FastifyError) => void,
) => {
  const portalApiUrl = process.env.PATIENT_PORTAL_API_URL || 'http://localhost:4001'
  const portalServiceToken = process.env.PORTAL_SERVICE_TOKEN || 'change-me-service-token'

  fastify.post('/external-consultants/invite', async (request, reply) => {
    try {
      const body = request.body as InviteConsultantPayload

      if (!body.email) {
        reply.code(400).send({ error: 'email is required' })
        return
      }

      // Call patient portal API to invite consultant
      const portalResponse = await fetch(`${portalApiUrl}/integrations/consultant-invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': portalServiceToken,
        },
        body: JSON.stringify({
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          specialty: body.specialty,
          organization: body.organization,
          expiresInHours: body.expiresInHours,
        }),
      })

      if (!portalResponse.ok) {
        const errorText = await portalResponse.text()
        fastify.log.error({ error: errorText, email: body.email }, 'Failed to invite consultant in portal')
        reply.code(portalResponse.status).send({ error: 'Failed to invite consultant', details: errorText })
        return
      }

      const portalData = await portalResponse.json()

      // Store consultant relationship in LaHIM core if needed
      // This is a placeholder - implement based on your LaHIM core schema
      // You might want to create a Practitioner record or ExternalConsultant record

      fastify.log.info({ email: body.email, portalUserId: portalData.userId }, 'consultant_invited')

      reply.code(201).send({
        portalUserId: portalData.userId,
        portalConsultantId: portalData.consultantId,
        inviteToken: portalData.inviteToken,
        inviteExpiresAt: portalData.inviteExpiresAt,
      })
    } catch (error) {
      fastify.log.error({ error }, 'external_consultants.invite_failed')
      reply.code(500).send({ error: 'Failed to invite external consultant' })
    }
  })

  next()
}

