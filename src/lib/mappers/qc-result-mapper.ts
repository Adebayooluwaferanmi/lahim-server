/**
 * Mapping functions between CouchDB QC Result documents and Prisma QcResult model
 */

export interface CouchQCResult {
  _id?: string
  _rev?: string
  type: 'qc_result'
  testCode?: {
    coding?: Array<{
      code: string
      system?: string
      display?: string
    }>
  } | string
  testName?: string
  materialId?: string
  materialName?: string
  materialLot?: string
  instrumentId?: string
  instrumentName?: string
  measuredValue?: number
  actualValue?: number
  targetValue?: number
  acceptableRangeLow?: number
  acceptableRangeHigh?: number
  unitUcum?: string
  qcRuleViolations?: string[]
  status?: 'pass' | 'fail' | 'warning' | string
  runDate?: string
  runAt?: string
  runNumber?: string
  performerId?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB QC result document to Prisma QcResult input
 */
export function mapCouchToPrismaQCResult(couchDoc: CouchQCResult): {
  id: string
  instrumentId: string | null
  testCodeLoinc: string
  qcMaterialLot: string
  targetValue: number | null
  acceptableRangeLow: number | null
  acceptableRangeHigh: number | null
  actualValue: number
  unitUcum: string | null
  qcRuleViolations: string[]
  status: string
  runAt: Date
  performerId: string | null
} {
  // Extract test code
  let testCodeLoinc = ''
  if (typeof couchDoc.testCode === 'string') {
    testCodeLoinc = couchDoc.testCode
  } else if (couchDoc.testCode?.coding?.[0]?.code) {
    testCodeLoinc = couchDoc.testCode.coding[0].code
  }

  // Extract measured/actual value
  const actualValue = couchDoc.actualValue ?? couchDoc.measuredValue ?? 0

  // Extract material lot
  const materialLot = couchDoc.materialLot || couchDoc.materialName || ''

  // Extract run date
  const runDate = couchDoc.runAt || couchDoc.runDate || new Date().toISOString()

  // Extract status
  const status = couchDoc.status || 'pass'

  return {
    id: couchDoc._id || '',
    instrumentId: couchDoc.instrumentId || null,
    testCodeLoinc,
    qcMaterialLot: materialLot,
    targetValue: couchDoc.targetValue ?? null,
    acceptableRangeLow: couchDoc.acceptableRangeLow ?? null,
    acceptableRangeHigh: couchDoc.acceptableRangeHigh ?? null,
    actualValue,
    unitUcum: couchDoc.unitUcum || null,
    qcRuleViolations: couchDoc.qcRuleViolations || [],
    status,
    runAt: new Date(runDate),
    performerId: couchDoc.performerId || null,
  }
}

/**
 * Map Prisma QcResult to CouchDB format
 */
export function mapPrismaToCouchQCResult(prismaResult: any): CouchQCResult {
  return {
    _id: prismaResult.id,
    type: 'qc_result',
    testCode: {
      coding: [{ code: prismaResult.testCodeLoinc }],
    },
    testName: prismaResult.testCatalog?.name,
    materialLot: prismaResult.qcMaterialLot,
    instrumentId: prismaResult.instrumentId,
    instrumentName: prismaResult.instrument?.name,
    measuredValue: prismaResult.actualValue,
    actualValue: prismaResult.actualValue,
    targetValue: prismaResult.targetValue,
    acceptableRangeLow: prismaResult.acceptableRangeLow,
    acceptableRangeHigh: prismaResult.acceptableRangeHigh,
    unitUcum: prismaResult.unitUcum,
    qcRuleViolations: prismaResult.qcRuleViolations || [],
    status: prismaResult.status,
    runDate: prismaResult.runAt.toISOString(),
    runAt: prismaResult.runAt.toISOString(),
    runNumber: prismaResult.id.substring(0, 8),
    performerId: prismaResult.performerId,
    createdAt: prismaResult.createdAt.toISOString(),
    updatedAt: prismaResult.updatedAt.toISOString(),
  }
}

