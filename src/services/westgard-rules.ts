import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'

/**
 * Westgard Rules Implementation
 * Implements all 6 Westgard rules for QC validation:
 * 1. 1-2s: One control result exceeds ±2SD
 * 2. 1-3s: One control result exceeds ±3SD
 * 3. 2-2s: Two consecutive control results exceed ±2SD on the same side
 * 4. R-4s: Two consecutive control results differ by more than 4SD
 * 5. 4-1s: Four consecutive control results exceed ±1SD on the same side
 * 6. 10x: Ten consecutive control results on the same side of the mean
 */

interface QCResult {
  id?: string
  _id?: string
  testCode: string | { coding: Array<{ code: string }> }
  instrumentId?: string
  materialId?: string
  actualValue: number
  targetValue?: number
  mean?: number
  standardDeviation?: number
  runDate?: string
  createdAt?: string
}

interface WestgardRuleViolation {
  rule: string
  description: string
  severity: 'warning' | 'error'
  zScore?: number
}

/**
 * Calculate Z-score for a QC result
 */
function calculateZScore(actualValue: number, mean: number, standardDeviation: number): number {
  if (standardDeviation === 0) return 0
  return (actualValue - mean) / standardDeviation
}

/**
 * Check Westgard Rule 1-2s: One control result exceeds ±2SD
 */
function checkRule12s(actualValue: number, mean: number, sd: number): WestgardRuleViolation | null {
  const zScore = calculateZScore(actualValue, mean, sd)
  if (Math.abs(zScore) > 2) {
    return {
      rule: '1-2s',
      description: `One control result exceeds ±2SD (Z-score: ${zScore.toFixed(2)})`,
      severity: 'warning',
      zScore,
    }
  }
  return null
}

/**
 * Check Westgard Rule 1-3s: One control result exceeds ±3SD
 */
function checkRule13s(actualValue: number, mean: number, sd: number): WestgardRuleViolation | null {
  const zScore = calculateZScore(actualValue, mean, sd)
  if (Math.abs(zScore) > 3) {
    return {
      rule: '1-3s',
      description: `One control result exceeds ±3SD (Z-score: ${zScore.toFixed(2)}) - REJECT`,
      severity: 'error',
      zScore,
    }
  }
  return null
}

/**
 * Check Westgard Rule 2-2s: Two consecutive control results exceed ±2SD on the same side
 */
function checkRule22s(
  currentValue: number,
  previousValue: number,
  mean: number,
  sd: number,
): WestgardRuleViolation | null {
  const currentZ = calculateZScore(currentValue, mean, sd)
  const previousZ = calculateZScore(previousValue, mean, sd)

  if (Math.abs(currentZ) > 2 && Math.abs(previousZ) > 2) {
    // Check if both are on the same side
    if ((currentZ > 2 && previousZ > 2) || (currentZ < -2 && previousZ < -2)) {
      return {
        rule: '2-2s',
        description: `Two consecutive control results exceed ±2SD on the same side - REJECT`,
        severity: 'error',
        zScore: currentZ,
      }
    }
  }
  return null
}

/**
 * Check Westgard Rule R-4s: Two consecutive control results differ by more than 4SD
 */
function checkRuleR4s(currentValue: number, previousValue: number, sd: number): WestgardRuleViolation | null {
  const difference = Math.abs(currentValue - previousValue)
  if (difference > 4 * sd) {
    return {
      rule: 'R-4s',
      description: `Two consecutive control results differ by more than 4SD - REJECT`,
      severity: 'error',
    }
  }
  return null
}

/**
 * Check Westgard Rule 4-1s: Four consecutive control results exceed ±1SD on the same side
 */
function checkRule41s(
  values: number[],
  mean: number,
  sd: number,
): WestgardRuleViolation | null {
  if (values.length < 4) return null

  const lastFour = values.slice(-4)
  const zScores = lastFour.map((v) => calculateZScore(v, mean, sd))

  // Check if all 4 are on the same side and exceed ±1SD
  const allPositive = zScores.every((z) => z > 1)
  const allNegative = zScores.every((z) => z < -1)

  if (allPositive || allNegative) {
    return {
      rule: '4-1s',
      description: `Four consecutive control results exceed ±1SD on the same side - REJECT`,
      severity: 'error',
      zScore: zScores[zScores.length - 1],
    }
  }
  return null
}

/**
 * Check Westgard Rule 10x: Ten consecutive control results on the same side of the mean
 */
function checkRule10x(values: number[], mean: number): WestgardRuleViolation | null {
  if (values.length < 10) return null

  const lastTen = values.slice(-10)
  const allAbove = lastTen.every((v) => v > mean)
  const allBelow = lastTen.every((v) => v < mean)

  if (allAbove || allBelow) {
    return {
      rule: '10x',
      description: `Ten consecutive control results on the same side of the mean - REJECT`,
      severity: 'error',
    }
  }
  return null
}

/**
 * Evaluate all Westgard rules for a QC result
 */
export function evaluateWestgardRules(
  currentResult: QCResult,
  previousResults: QCResult[],
  mean: number,
  standardDeviation: number,
): WestgardRuleViolation[] {
  const violations: WestgardRuleViolation[] = []

  if (!currentResult.actualValue || !mean || !standardDeviation) {
    return violations
  }

  // Rule 1-2s: Warning
  const rule12s = checkRule12s(currentResult.actualValue, mean, standardDeviation)
  if (rule12s) violations.push(rule12s)

  // Rule 1-3s: Error (reject)
  const rule13s = checkRule13s(currentResult.actualValue, mean, standardDeviation)
  if (rule13s) violations.push(rule13s)

  // Rules requiring previous results
  if (previousResults.length > 0) {
    const previousResult = previousResults[previousResults.length - 1]

    // Rule 2-2s: Two consecutive exceed ±2SD on same side
    if (previousResult.actualValue !== undefined) {
      const rule22s = checkRule22s(
        currentResult.actualValue,
        previousResult.actualValue,
        mean,
        standardDeviation,
      )
      if (rule22s) violations.push(rule22s)
    }

    // Rule R-4s: Two consecutive differ by >4SD
    if (previousResult.actualValue !== undefined) {
      const ruleR4s = checkRuleR4s(currentResult.actualValue, previousResult.actualValue, standardDeviation)
      if (ruleR4s) violations.push(ruleR4s)
    }
  }

  // Rules requiring multiple previous results
  if (previousResults.length >= 3) {
    const allValues = [...previousResults.map((r) => r.actualValue), currentResult.actualValue].filter(
      (v): v is number => v !== undefined,
    )

    // Rule 4-1s: Four consecutive exceed ±1SD on same side
    if (allValues.length >= 4) {
      const rule41s = checkRule41s(allValues, mean, standardDeviation)
      if (rule41s) violations.push(rule41s)
    }

    // Rule 10x: Ten consecutive on same side of mean
    if (allValues.length >= 10) {
      const rule10x = checkRule10x(allValues, mean)
      if (rule10x) violations.push(rule10x)
    }
  }

  return violations
}

/**
 * Get QC statistics (mean, SD) for a test
 */
export async function getQCStatistics(
  fastify: FastifyInstance,
  testCode: string | { coding?: Array<{ code?: string }> },
  materialId: string,
  instrumentId?: string,
  limit: number = 30,
): Promise<{ mean: number; standardDeviation: number; count: number }> {
  const db = fastify.couch.db.use('qc_results')
  const testCodeValue = typeof testCode === 'string' ? testCode : (testCode as any)?.coding?.[0]?.code || ''

  const selector: any = {
    type: 'qc_result',
    'testCode.coding.code': testCodeValue,
    materialId,
  }

  if (instrumentId) {
    selector.instrumentId = instrumentId
  }

  const result = await db.find({
    selector,
    sort: [{ runDate: 'desc' }],
    limit,
  })

  const values = result.docs
    .map((doc: any) => doc.actualValue)
    .filter((v: any): v is number => typeof v === 'number' && !isNaN(v))

  if (values.length === 0) {
    throw new Error('No QC results found for statistics calculation')
  }

  // Calculate mean
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length

  // Calculate standard deviation
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
  const standardDeviation = Math.sqrt(variance)

  return { mean, standardDeviation, count: values.length }
}

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('qc_results')

  // POST /westgard-rules/evaluate - Evaluate Westgard rules for a QC result
  fastify.post('/westgard-rules/evaluate', async (request, reply) => {
    try {
      const { qcResultId, testCode, materialId, instrumentId, useHistorical } = request.body as any

      if (!testCode || !materialId) {
        reply.code(400).send({ error: 'Test code and material ID are required' })
        return
      }

      // Get the QC result
      let currentResult: QCResult
      if (qcResultId) {
        const doc = await db.get(qcResultId)
        currentResult = doc as any
      } else {
        reply.code(400).send({ error: 'QC result ID is required' })
        return
      }

      // Get QC statistics
      const stats = await getQCStatistics(fastify, testCode, materialId, instrumentId)

      // Get previous results for trend analysis
      const previousResults: QCResult[] = []
      if (useHistorical) {
        const testCodeValue = typeof testCode === 'string' ? testCode : testCode.coding?.[0]?.code || ''
        const selector: any = {
          type: 'qc_result',
          'testCode.coding.code': testCodeValue,
          materialId,
          _id: { $ne: qcResultId },
        }
        if (instrumentId) selector.instrumentId = instrumentId

        const prevResult = await db.find({
          selector,
          sort: [{ runDate: 'desc' }],
          limit: 10,
        })
        previousResults.push(...(prevResult.docs as any[]))
      }

      // Evaluate rules
      const violations = evaluateWestgardRules(currentResult, previousResults, stats.mean, stats.standardDeviation)

      // Determine overall status
      const hasError = violations.some((v) => v.severity === 'error')
      const status = hasError ? 'fail' : violations.length > 0 ? 'warning' : 'pass'

      fastify.log.info(
        { qcResultId, violations: violations.length, status },
        'westgard_rules.evaluated',
      )

      reply.send({
        status,
        violations,
        statistics: stats,
        zScore: currentResult.actualValue
          ? calculateZScore(currentResult.actualValue, stats.mean, stats.standardDeviation)
          : undefined,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'westgard_rules.evaluate_failed')
      reply.code(500).send({ error: 'Failed to evaluate Westgard rules' })
    }
  })

  // GET /westgard-rules/statistics - Get QC statistics for a test
  fastify.get('/westgard-rules/statistics', async (request, reply) => {
    try {
      const { testCode, materialId, instrumentId, limit = 30 } = request.query as any

      if (!testCode || !materialId) {
        reply.code(400).send({ error: 'Test code and material ID are required' })
        return
      }

      const stats = await getQCStatistics(fastify, testCode, materialId, instrumentId, parseInt(limit, 10))

      fastify.log.debug({ testCode, materialId, count: stats.count }, 'westgard_rules.statistics')
      reply.send(stats)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'westgard_rules.statistics_failed')
      reply.code(500).send({ error: 'Failed to get QC statistics' })
    }
  })

  next()
}

