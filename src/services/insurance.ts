import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

/**
 * Insurance Management Service
 * 
 * Manages insurance providers, patient insurance information, and coverage
 */

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'insurance_providers')
    await ensureCouchDBDatabase(fastify, 'patient_insurance')
    await ensureCouchDBDatabase(fastify, 'prior_authorizations')
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Insurance service: CouchDB not available - endpoints will return errors')
    return
  }

  const providersDb = fastify.couch.db.use('insurance_providers')
  const patientInsuranceDb = fastify.couch.db.use('patient_insurance')
  // const priorAuthDb = fastify.couch.db.use('prior_authorizations') // Reserved for future use

  createCouchDBIndexes(
    fastify,
    'insurance_providers',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'name'] }, name: 'type-name-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
    ],
    'Insurance Providers'
  )

  createCouchDBIndexes(
    fastify,
    'patient_insurance',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'providerId'] }, name: 'type-providerId-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
    ],
    'Patient Insurance'
  )

  createCouchDBIndexes(
    fastify,
    'prior_authorizations',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Prior Authorizations'
  )

  // GET /insurance/providers - List insurance providers
  fastify.get('/insurance/providers', async (request, reply) => {
    try {
      const { active, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'insurance_provider' }

      if (active !== undefined) selector.active = active === 'true'

      const result = await providersDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ name: 'asc' }],
      })

      reply.send({ providers: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'insurance.providers.list_failed')
      reply.code(500).send({ error: 'Failed to list insurance providers' })
    }
  })

  // POST /insurance/providers - Create insurance provider
  fastify.post('/insurance/providers', async (request, reply) => {
    try {
      const provider = request.body as any
      const now = new Date().toISOString()

      const newProvider = {
        ...provider,
        type: 'insurance_provider',
        active: provider.active !== undefined ? provider.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await providersDb.insert(newProvider)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newProvider })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'insurance.providers.create_failed')
      reply.code(500).send({ error: 'Failed to create insurance provider' })
    }
  })

  // GET /insurance/patients/:patientId - Get patient insurance information
  fastify.get('/insurance/patients/:patientId', async (request, reply) => {
    try {
      const { patientId } = request.params as { patientId: string }

      const result = await patientInsuranceDb.find({
        selector: {
          type: 'patient_insurance',
          patientId,
          active: true,
        },
        sort: [{ isPrimary: 'desc' }],
      })

      reply.send({ insurance: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'insurance.patient.get_failed')
      reply.code(500).send({ error: 'Failed to get patient insurance' })
    }
  })

  // POST /insurance/patients/:patientId - Add/update patient insurance
  fastify.post('/insurance/patients/:patientId', async (request, reply) => {
    try {
      const { patientId } = request.params as { patientId: string }
      const insurance = request.body as any
      const now = new Date().toISOString()

      const newInsurance = {
        ...insurance,
        type: 'patient_insurance',
        patientId,
        active: insurance.active !== undefined ? insurance.active : true,
        createdAt: now,
        updatedAt: now,
      }

      const result = await patientInsuranceDb.insert(newInsurance)
      reply.code(201).send({ id: result.id, rev: result.rev, ...newInsurance })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'insurance.patient.create_failed')
      reply.code(500).send({ error: 'Failed to add patient insurance' })
    }
  })

  // POST /insurance/verify - Verify insurance coverage
  fastify.post('/insurance/verify', async (request, reply) => {
    try {
      const { patientId, serviceCode: _serviceCode, date: _date } = request.body as any

      // Get patient's active insurance
      const insuranceResult = await patientInsuranceDb.find({
        selector: {
          type: 'patient_insurance',
          patientId,
          active: true,
        },
        limit: 1,
      })

      if (insuranceResult.docs.length === 0) {
        reply.send({
          covered: false,
          reason: 'No active insurance found',
        })
        return
      }

      const insurance = insuranceResult.docs[0] as any

      // Basic verification (can be extended with real insurance API)
      reply.send({
        covered: true,
        insurance,
        copay: insurance.copay || 0,
        deductible: insurance.deductible || 0,
        coveragePercentage: insurance.coveragePercentage || 80,
        requiresPriorAuth: false, // Can be determined based on service code
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'insurance.verify_failed')
      reply.code(500).send({ error: 'Failed to verify insurance' })
    }
  })
}

