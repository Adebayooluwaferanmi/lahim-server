import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

/**
 * NHIA (National Health Insurance Authority) Integration Service
 * 
 * Implements NHIA integration based on standard health insurance API patterns:
 * - Member verification using NHIS number/card number
 * - Eligibility checking
 * - Benefit inquiry
 * - Claims submission
 * 
 * Configuration via environment variables:
 * - NHIA_API_BASE_URL: Base URL for NHIA API (e.g., https://api.nhia.gov.gh)
 * - NHIA_API_KEY: API key for authentication
 * - NHIA_FACILITY_CODE: Facility/provider code assigned by NHIA
 * - NHIA_FACILITY_NAME: Name of the healthcare facility
 */

interface NHIAMemberVerificationRequest {
  nhisNumber?: string
  cardNumber?: string
  dateOfBirth?: string
  firstName?: string
  lastName?: string
}

interface NHIAMemberVerificationResponse {
  valid: boolean
  memberId?: string
  nhisNumber?: string
  cardNumber?: string
  firstName?: string
  lastName?: string
  dateOfBirth?: string
  gender?: string
  membershipType?: string
  membershipStatus?: 'active' | 'inactive' | 'suspended' | 'expired'
  expiryDate?: string
  premiumStatus?: 'paid' | 'unpaid' | 'partial'
  scheme?: string
  message?: string
}

interface NHIAEligibilityRequest {
  memberId: string
  nhisNumber?: string
  serviceCode?: string
  serviceDate?: string
  facilityCode?: string
}

interface NHIAEligibilityResponse {
  eligible: boolean
  memberId?: string
  nhisNumber?: string
  coverageType?: string
  benefitPackage?: string
  copay?: number
  coveragePercentage?: number
  deductible?: number
  requiresPriorAuth?: boolean
  priorAuthNumber?: string
  restrictions?: string[]
  message?: string
}

interface NHIAClaimRequest {
  memberId: string
  nhisNumber?: string
  facilityCode: string
  serviceDate: string
  services: Array<{
    serviceCode: string
    serviceName: string
    quantity: number
    unitPrice: number
    totalPrice: number
  }>
  diagnosis?: string[]
  providerId?: string
  claimType?: 'inpatient' | 'outpatient' | 'pharmacy' | 'laboratory'
}

interface NHIAClaimResponse {
  success: boolean
  claimId?: string
  claimNumber?: string
  status?: 'submitted' | 'approved' | 'rejected' | 'pending'
  amountApproved?: number
  amountRejected?: number
  rejectionReason?: string
  message?: string
}

/**
 * Make HTTP request to NHIA API
 */
async function nhiaApiRequest(
  fastify: FastifyInstance,
  endpoint: string,
  method: 'GET' | 'POST' = 'POST',
  body?: any
): Promise<any> {
  const baseUrl = process.env.NHIA_API_BASE_URL || ''
  const apiKey = process.env.NHIA_API_KEY || ''
  const facilityCode = process.env.NHIA_FACILITY_CODE || ''

  if (!baseUrl) {
    fastify.log.warn('NHIA_API_BASE_URL not configured - using mock responses')
    return null
  }

  try {
    const url = `${baseUrl}${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
      headers['X-API-Key'] = apiKey
    }

    if (facilityCode) {
      headers['X-Facility-Code'] = facilityCode
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorText = await response.text()
      fastify.log.error(
        { status: response.status, error: errorText },
        'NHIA API request failed'
      )
      throw new Error(`NHIA API error: ${response.status} - ${errorText}`)
    }

    return await response.json()
  } catch (error: unknown) {
    fastify.log.error(error as Error, 'NHIA API request error')
    throw error
  }
}

/**
 * Verify NHIA member
 */
async function verifyNHIAMember(
  fastify: FastifyInstance,
  request: NHIAMemberVerificationRequest
): Promise<NHIAMemberVerificationResponse> {
  try {
    // Try real API first
    const apiResponse = await nhiaApiRequest(
      fastify,
      '/api/v1/members/verify',
      'POST',
      request
    )

    if (apiResponse) {
      return {
        valid: apiResponse.valid || false,
        memberId: apiResponse.memberId,
        nhisNumber: apiResponse.nhisNumber || request.nhisNumber,
        cardNumber: apiResponse.cardNumber || request.cardNumber,
        firstName: apiResponse.firstName,
        lastName: apiResponse.lastName,
        dateOfBirth: apiResponse.dateOfBirth,
        gender: apiResponse.gender,
        membershipType: apiResponse.membershipType,
        membershipStatus: apiResponse.membershipStatus || 'active',
        expiryDate: apiResponse.expiryDate,
        premiumStatus: apiResponse.premiumStatus,
        scheme: apiResponse.scheme,
        message: apiResponse.message,
      }
    }

    // Mock response for development/testing
    fastify.log.info('Using mock NHIA member verification')
    return {
      valid: true,
      memberId: 'MEMBER_' + Date.now(),
      nhisNumber: request.nhisNumber || 'NHIS123456789',
      cardNumber: request.cardNumber || 'CARD123456789',
      firstName: request.firstName || 'John',
      lastName: request.lastName || 'Doe',
      dateOfBirth: request.dateOfBirth || '1990-01-01',
      gender: 'M',
      membershipType: 'Standard',
      membershipStatus: 'active',
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      premiumStatus: 'paid',
      scheme: 'NHIS',
      message: 'Member verified successfully (mock)',
    }
  } catch (error: unknown) {
    fastify.log.error(error as Error, 'NHIA member verification failed')
    return {
      valid: false,
      message: (error as Error).message || 'Verification failed',
    }
  }
}

/**
 * Check NHIA eligibility
 */
async function checkNHIAEligibility(
  fastify: FastifyInstance,
  request: NHIAEligibilityRequest
): Promise<NHIAEligibilityResponse> {
  try {
    const apiResponse = await nhiaApiRequest(
      fastify,
      '/api/v1/members/eligibility',
      'POST',
      request
    )

    if (apiResponse) {
      return {
        eligible: apiResponse.eligible || false,
        memberId: apiResponse.memberId || request.memberId,
        nhisNumber: apiResponse.nhisNumber || request.nhisNumber,
        coverageType: apiResponse.coverageType,
        benefitPackage: apiResponse.benefitPackage,
        copay: apiResponse.copay || 0,
        coveragePercentage: apiResponse.coveragePercentage || 100,
        deductible: apiResponse.deductible || 0,
        requiresPriorAuth: apiResponse.requiresPriorAuth || false,
        priorAuthNumber: apiResponse.priorAuthNumber,
        restrictions: apiResponse.restrictions || [],
        message: apiResponse.message,
      }
    }

    // Mock response
    fastify.log.info('Using mock NHIA eligibility check')
    return {
      eligible: true,
      memberId: request.memberId,
      nhisNumber: request.nhisNumber,
      coverageType: 'Standard',
      benefitPackage: 'Basic',
      copay: 0,
      coveragePercentage: 100,
      deductible: 0,
      requiresPriorAuth: false,
      message: 'Eligible for service (mock)',
    }
  } catch (error: unknown) {
    fastify.log.error(error as Error, 'NHIA eligibility check failed')
    return {
      eligible: false,
      memberId: request.memberId,
      message: (error as Error).message || 'Eligibility check failed',
    }
  }
}

/**
 * Submit NHIA claim
 */
async function submitNHIAClaim(
  fastify: FastifyInstance,
  request: NHIAClaimRequest
): Promise<NHIAClaimResponse> {
  try {
    const apiResponse = await nhiaApiRequest(
      fastify,
      '/api/v1/claims/submit',
      'POST',
      request
    )

    if (apiResponse) {
      return {
        success: apiResponse.success || false,
        claimId: apiResponse.claimId,
        claimNumber: apiResponse.claimNumber,
        status: apiResponse.status || 'submitted',
        amountApproved: apiResponse.amountApproved,
        amountRejected: apiResponse.amountRejected,
        rejectionReason: apiResponse.rejectionReason,
        message: apiResponse.message,
      }
    }

    // Mock response
    fastify.log.info('Using mock NHIA claim submission')
    const totalAmount = request.services.reduce((sum, s) => sum + s.totalPrice, 0)
    return {
      success: true,
      claimId: 'CLAIM_' + Date.now(),
      claimNumber: 'CLM-' + Date.now().toString().slice(-10),
      status: 'submitted',
      amountApproved: totalAmount,
      message: 'Claim submitted successfully (mock)',
    }
  } catch (error: unknown) {
    fastify.log.error(error as Error, 'NHIA claim submission failed')
    return {
      success: false,
      status: 'rejected',
      rejectionReason: (error as Error).message || 'Submission failed',
      message: 'Failed to submit claim',
    }
  }
}

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists for NHIA claims
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'nhia_claims')
    await ensureCouchDBDatabase(fastify, 'nhia_verifications')
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('NHIA service: CouchDB not available - endpoints will return errors')
    return
  }

  const claimsDb = fastify.couch.db.use('nhia_claims')
  const verificationsDb = fastify.couch.db.use('nhia_verifications')

  createCouchDBIndexes(
    fastify,
    'nhia_claims',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'memberId'] }, name: 'type-memberId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'serviceDate'] }, name: 'type-serviceDate-index' },
    ],
    'NHIA Claims'
  )

  createCouchDBIndexes(
    fastify,
    'nhia_verifications',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'memberId'] }, name: 'type-memberId-index' },
      { index: { fields: ['type', 'nhisNumber'] }, name: 'type-nhisNumber-index' },
      { index: { fields: ['type', 'verifiedAt'] }, name: 'type-verifiedAt-index' },
    ],
    'NHIA Verifications'
  )

  // POST /nhia/members/verify - Verify NHIA member
  fastify.post('/nhia/members/verify', async (request, reply) => {
    try {
      const verificationRequest = request.body as NHIAMemberVerificationRequest

      if (!verificationRequest.nhisNumber && !verificationRequest.cardNumber) {
        reply.code(400).send({
          error: 'Either nhisNumber or cardNumber is required',
        })
        return
      }

      const verification = await verifyNHIAMember(fastify, verificationRequest)

      // Store verification record
      if (verification.valid && verification.memberId) {
        try {
          await verificationsDb.insert({
            type: 'nhia_verification',
            memberId: verification.memberId,
            nhisNumber: verification.nhisNumber,
            cardNumber: verification.cardNumber,
            verifiedAt: new Date().toISOString(),
            result: verification,
            createdAt: new Date().toISOString(),
          } as any)
        } catch (dbError) {
          fastify.log.warn(dbError, 'Failed to store verification record')
        }
      }

      reply.send(verification)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'nhia.member.verify_failed')
      reply.code(500).send({ error: 'Failed to verify NHIA member' })
    }
  })

  // POST /nhia/members/eligibility - Check member eligibility
  fastify.post('/nhia/members/eligibility', async (request, reply) => {
    try {
      const eligibilityRequest = request.body as NHIAEligibilityRequest

      if (!eligibilityRequest.memberId) {
        reply.code(400).send({
          error: 'memberId is required',
        })
        return
      }

      const eligibility = await checkNHIAEligibility(fastify, eligibilityRequest)

      reply.send(eligibility)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'nhia.member.eligibility_failed')
      reply.code(500).send({ error: 'Failed to check NHIA eligibility' })
    }
  })

  // POST /nhia/claims/submit - Submit NHIA claim
  fastify.post('/nhia/claims/submit', async (request, reply) => {
    try {
      const claimRequest = request.body as NHIAClaimRequest

      if (!claimRequest.memberId || !claimRequest.services || claimRequest.services.length === 0) {
        reply.code(400).send({
          error: 'memberId and services are required',
        })
        return
      }

      const facilityCode = claimRequest.facilityCode || process.env.NHIA_FACILITY_CODE || ''
      if (!facilityCode) {
        reply.code(400).send({
          error: 'facilityCode is required',
        })
        return
      }

      const claimResponse = await submitNHIAClaim(fastify, {
        ...claimRequest,
        facilityCode,
      })

      // Store claim record
      if (claimResponse.claimId) {
        try {
          await claimsDb.insert({
            type: 'nhia_claim',
            claimId: claimResponse.claimId,
            claimNumber: claimResponse.claimNumber,
            memberId: claimRequest.memberId,
            nhisNumber: claimRequest.nhisNumber,
            facilityCode,
            serviceDate: claimRequest.serviceDate,
            services: claimRequest.services,
            status: claimResponse.status || 'submitted',
            amountApproved: claimResponse.amountApproved,
            amountRejected: claimResponse.amountRejected,
            rejectionReason: claimResponse.rejectionReason,
            submittedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          } as any)
        } catch (dbError) {
          fastify.log.warn(dbError, 'Failed to store claim record')
        }
      }

      reply.send(claimResponse)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'nhia.claim.submit_failed')
      reply.code(500).send({ error: 'Failed to submit NHIA claim' })
    }
  })

  // GET /nhia/claims/:claimId - Get claim status
  fastify.get('/nhia/claims/:claimId', async (request, reply) => {
    try {
      const { claimId } = request.params as { claimId: string }

      const result = await claimsDb.find({
        selector: {
          type: 'nhia_claim',
          claimId,
        },
        limit: 1,
      })

      if (result.docs.length === 0) {
        reply.code(404).send({ error: 'Claim not found' })
        return
      }

      reply.send(result.docs[0])
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'nhia.claim.get_failed')
      reply.code(500).send({ error: 'Failed to get NHIA claim' })
    }
  })

  // GET /nhia/claims - List claims
  fastify.get('/nhia/claims', async (request, reply) => {
    try {
      const { memberId, status, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'nhia_claim' }

      if (memberId) selector.memberId = memberId
      if (status) selector.status = status

      const result = await claimsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ submittedAt: 'desc' }],
      })

      reply.send({ claims: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'nhia.claims.list_failed')
      reply.code(500).send({ error: 'Failed to list NHIA claims' })
    }
  })
}


