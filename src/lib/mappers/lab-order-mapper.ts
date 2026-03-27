/**
 * Mapping functions between CouchDB Lab Order documents and Prisma LabOrder model
 */

export interface CouchLabOrder {
  _id?: string
  _rev?: string
  type: 'lab_order'
  patientId: string
  isPanel?: boolean
  panelId?: string
  testCodeLoinc?: string
  tests?: Array<{
    testCode?: {
      coding?: Array<{
        code: string
        system?: string
        display?: string
      }>
    } | string
  }>
  status: string
  priority?: string
  orderedOn?: string
  collectedOn?: string
  receivedOn?: string
  finalizedOn?: string
  facilityId?: string
  practitionerId?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB lab order document to Prisma LabOrder input
 * Handles both panel orders and individual test orders
 */
export function mapCouchToPrismaLabOrder(couchDoc: CouchLabOrder): {
  id: string
  patientId: string
  testCodeLoinc: string | null
  panelId: string | null
  isPanel: boolean
  status: string
  priority?: string
  orderedAt: Date
  collectedAt?: Date
  receivedAt?: Date
  finalizedAt?: Date
  facilityId?: string
  practitionerId?: string
} {
  // Handle panel orders
  if (couchDoc.isPanel && couchDoc.panelId) {
    return {
      id: couchDoc._id || '',
      patientId: couchDoc.patientId,
      testCodeLoinc: null,
      panelId: couchDoc.panelId,
      isPanel: true,
      status: couchDoc.status || 'ordered',
      priority: couchDoc.priority || undefined,
      orderedAt: couchDoc.orderedOn ? new Date(couchDoc.orderedOn) : new Date(),
      collectedAt: couchDoc.collectedOn ? new Date(couchDoc.collectedOn) : undefined,
      receivedAt: couchDoc.receivedOn ? new Date(couchDoc.receivedOn) : undefined,
      finalizedAt: couchDoc.finalizedOn ? new Date(couchDoc.finalizedOn) : undefined,
      facilityId: couchDoc.facilityId || undefined,
      practitionerId: couchDoc.practitionerId || undefined,
    }
  }

  // Handle individual test orders
  let testCodeLoinc: string | null = couchDoc.testCodeLoinc || null
  
  // Fallback: Extract test code from first test if testCodeLoinc not set
  if (!testCodeLoinc) {
    const firstTest = couchDoc.tests?.[0]
    if (firstTest && firstTest.testCode) {
      if (typeof firstTest.testCode === 'object' && firstTest.testCode !== null && 'coding' in firstTest.testCode) {
        const coding = firstTest.testCode.coding
        if (Array.isArray(coding) && coding.length > 0 && coding[0]?.code) {
          testCodeLoinc = coding[0].code
        }
      } else if (typeof firstTest.testCode === 'string') {
        testCodeLoinc = firstTest.testCode
      }
    }
  }

  // Ensure we have a valid test code for individual orders
  if (!testCodeLoinc || testCodeLoinc === '') {
    testCodeLoinc = 'UNKNOWN'
  }

  return {
    id: couchDoc._id || '',
    patientId: couchDoc.patientId,
    testCodeLoinc,
    panelId: null,
    isPanel: false,
    status: couchDoc.status || 'ordered',
    priority: couchDoc.priority || undefined,
    orderedAt: couchDoc.orderedOn ? new Date(couchDoc.orderedOn) : new Date(),
    collectedAt: couchDoc.collectedOn ? new Date(couchDoc.collectedOn) : undefined,
    receivedAt: couchDoc.receivedOn ? new Date(couchDoc.receivedOn) : undefined,
    finalizedAt: couchDoc.finalizedOn ? new Date(couchDoc.finalizedOn) : undefined,
    facilityId: couchDoc.facilityId || undefined,
    practitionerId: couchDoc.practitionerId || undefined,
  }
}

/**
 * Map Prisma LabOrder to CouchDB document structure
 */
export function mapPrismaToCouchLabOrder(
  prismaOrder: any,
  existingCouchDoc?: CouchLabOrder
): CouchLabOrder {
  // Preserve existing structure if available
  const baseDoc: CouchLabOrder = existingCouchDoc || {
    type: 'lab_order',
    patientId: prismaOrder.patientId,
    tests: [],
    status: prismaOrder.status,
  }

  // Update fields
  return {
    ...baseDoc,
    _id: prismaOrder.id,
    patientId: prismaOrder.patientId,
    status: prismaOrder.status,
    priority: prismaOrder.priority || baseDoc.priority,
    orderedOn: prismaOrder.orderedAt?.toISOString() || baseDoc.orderedOn,
    collectedOn: prismaOrder.collectedAt?.toISOString() || baseDoc.collectedOn,
    receivedOn: prismaOrder.receivedAt?.toISOString() || baseDoc.receivedOn,
    finalizedOn: prismaOrder.finalizedAt?.toISOString() || baseDoc.finalizedOn,
    facilityId: prismaOrder.facilityId || baseDoc.facilityId,
    practitionerId: prismaOrder.practitionerId || baseDoc.practitionerId,
    updatedAt: new Date().toISOString(),
  }
}

