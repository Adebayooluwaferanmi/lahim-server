/**
 * Mapping functions between CouchDB Lab Result documents and Prisma LabResult model
 */

export interface CouchLabResult {
  _id?: string
  _rev?: string
  type: 'lab_result'
  patientId: string
  orderId?: string
  specimenId?: string
  testCode?: {
    coding?: Array<{
      code: string
      system?: string
      display?: string
    }>
  } | string
  resultType: 'numeric' | 'coded' | 'text' | 'microbiology' | 'image'
  numericValue?: number
  unitUcum?: string
  codedValue?: {
    code?: string
    system?: string
    display?: string
  }
  textValue?: string
  referenceRange?: {
    low?: number
    high?: number
  }
  status?: string
  reportedDateTime?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB lab result document to Prisma LabResult input
 */
export function mapCouchToPrismaResult(couchDoc: CouchLabResult): {
  id: string
  orderId: string
  specimenId?: string
  analyteCodeLoinc: string
  resultType: string
  valueNumber?: number
  unitUcum?: string
  valueCode?: string
  valueText?: string
  codeSystem?: string
  refRangeLow?: number
  refRangeHigh?: number
  flags: string[]
  finalizedAt?: Date
  performerId?: string
} {
  // Extract test code
  let analyteCodeLoinc = ''
  if (couchDoc.testCode) {
    if (typeof couchDoc.testCode === 'object' && couchDoc.testCode !== null && 'coding' in couchDoc.testCode) {
      analyteCodeLoinc = couchDoc.testCode.coding?.[0]?.code || ''
    } else if (typeof couchDoc.testCode === 'string') {
      analyteCodeLoinc = couchDoc.testCode
    }
  }
  if (!analyteCodeLoinc) {
    analyteCodeLoinc = 'UNKNOWN'
  }

  // Extract value based on result type
  let valueNumber: number | undefined
  let valueCode: string | undefined
  let valueText: string | undefined
  let codeSystem: string | undefined

  if (couchDoc.resultType === 'numeric') {
    valueNumber = couchDoc.numericValue
  } else if (couchDoc.resultType === 'coded') {
    valueCode = couchDoc.codedValue?.code
    codeSystem = couchDoc.codedValue?.system
  } else if (couchDoc.resultType === 'text') {
    valueText = couchDoc.textValue
  }

  // Extract reference range
  const refRangeLow = couchDoc.referenceRange?.low
  const refRangeHigh = couchDoc.referenceRange?.high

  // Extract flags (simplified - would need more logic for actual flags)
  const flags: string[] = []

  return {
    id: couchDoc._id || '',
    orderId: couchDoc.orderId || '',
    specimenId: couchDoc.specimenId || undefined,
    analyteCodeLoinc,
    resultType: couchDoc.resultType,
    valueNumber,
    unitUcum: couchDoc.unitUcum || undefined,
    valueCode,
    valueText,
    codeSystem,
    refRangeLow,
    refRangeHigh,
    flags,
    finalizedAt: couchDoc.reportedDateTime ? new Date(couchDoc.reportedDateTime) : undefined,
    performerId: undefined, // Would need to extract from CouchDB doc
  }
}

/**
 * Map Prisma LabResult to CouchDB document structure
 */
export function mapPrismaToCouchResult(
  prismaResult: any,
  existingCouchDoc?: CouchLabResult
): CouchLabResult {
  const baseDoc: CouchLabResult = existingCouchDoc || {
    type: 'lab_result',
    patientId: '', // Would need to get from order
    resultType: prismaResult.resultType,
  }

  return {
    ...baseDoc,
    _id: prismaResult.id,
    orderId: prismaResult.orderId || baseDoc.orderId,
    specimenId: prismaResult.specimenId || baseDoc.specimenId,
    testCode: {
      coding: [{
        code: prismaResult.analyteCodeLoinc,
        system: 'http://loinc.org',
      }],
    },
    resultType: prismaResult.resultType,
    numericValue: prismaResult.valueNumber || baseDoc.numericValue,
    unitUcum: prismaResult.unitUcum || baseDoc.unitUcum,
    codedValue: prismaResult.valueCode ? {
      code: prismaResult.valueCode,
      system: prismaResult.codeSystem,
    } : baseDoc.codedValue,
    textValue: prismaResult.valueText || baseDoc.textValue,
    referenceRange: (prismaResult.refRangeLow !== undefined || prismaResult.refRangeHigh !== undefined) ? {
      low: prismaResult.refRangeLow,
      high: prismaResult.refRangeHigh,
    } : baseDoc.referenceRange,
    status: prismaResult.finalizedAt ? 'final' : 'preliminary',
    reportedDateTime: prismaResult.finalizedAt?.toISOString() || baseDoc.reportedDateTime,
    updatedAt: new Date().toISOString(),
  }
}

