/**
 * Mapping functions between CouchDB Worklist documents and Prisma Worklist model
 */

export interface CouchWorklist {
  _id?: string
  _rev?: string
  type: 'worklist'
  date?: string
  mode?: 'auto' | 'manual'
  instrumentId?: string
  section?: string
  priority?: string
  status?: string
  testCodes?: string[]
  orders?: Array<{
    orderId: string
    patientId: string
    tests: Array<{
      testCode?: {
        coding?: Array<{
          code: string
          display?: string
        }>
      } | string
      testName?: string
    }>
  }>
  specimens?: Array<{
    specimenId: string
    orderId: string
    specimenType?: any
  }>
  generatedAt?: string
  completedAt?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB worklist document to Prisma Worklist and WorklistItem inputs
 */
export function mapCouchToPrismaWorklist(couchDoc: CouchWorklist): {
  worklist: {
    id: string
    section: string
    instrumentId: string | null
    priority: string | null
    status: string
    generatedAt: Date
    completedAt: Date | null
  }
  items: Array<{
    id: string
    worklistId: string
    orderId: string
    testCodeLoinc: string
    assignedTo: string | null
    status: string
  }>
} {
  const worklistId = couchDoc._id || `worklist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  
  // Extract section from testCodes or use default
  const section = couchDoc.section || 'General'
  
  // Extract generatedAt date
  const generatedAt = couchDoc.generatedAt 
    ? new Date(couchDoc.generatedAt)
    : couchDoc.date
    ? new Date(`${couchDoc.date}T00:00:00Z`)
    : new Date()

  // Extract completedAt
  const completedAt = couchDoc.completedAt ? new Date(couchDoc.completedAt) : null

  // Build worklist items from orders array
  const items: Array<{
    id: string
    worklistId: string
    orderId: string
    testCodeLoinc: string
    assignedTo: string | null
    status: string
  }> = []

  if (couchDoc.orders && Array.isArray(couchDoc.orders)) {
    couchDoc.orders.forEach((order) => {
      if (order.tests && Array.isArray(order.tests)) {
        order.tests.forEach((test) => {
          // Extract test code
          let testCodeLoinc = ''
          if (typeof test.testCode === 'string') {
            testCodeLoinc = test.testCode
          } else if (test.testCode?.coding?.[0]?.code) {
            testCodeLoinc = test.testCode.coding[0].code
          }

          if (testCodeLoinc) {
            items.push({
              id: `${worklistId}_item_${items.length}_${Math.random().toString(36).substr(2, 9)}`,
              worklistId,
              orderId: order.orderId,
              testCodeLoinc,
              assignedTo: null,
              status: 'pending',
            })
          }
        })
      }
    })
  }

  return {
    worklist: {
      id: worklistId,
      section,
      instrumentId: couchDoc.instrumentId || null,
      priority: couchDoc.priority || null,
      status: couchDoc.status || 'pending',
      generatedAt,
      completedAt,
    },
    items,
  }
}

/**
 * Map Prisma Worklist and WorklistItem[] to CouchDB format
 */
export function mapPrismaToCouchWorklist(prismaWorklist: any, items: any[]): CouchWorklist {
  // Group items by orderId
  const orderMap = new Map<string, {
    orderId: string
    patientId: string
    tests: Array<{
      testCode: {
        coding: Array<{
          code: string
          display?: string
        }>
      }
      testName?: string
    }>
  }>()

  const testCodesSet = new Set<string>()

  items.forEach((item) => {
    if (item.order) {
      const orderId = item.order.id
      if (!orderMap.has(orderId)) {
        orderMap.set(orderId, {
          orderId,
          patientId: item.order.patientId,
          tests: [],
        })
      }
      const orderEntry = orderMap.get(orderId)!
      
      if (item.testCatalog) {
        orderEntry.tests.push({
          testCode: {
            coding: [{
              code: item.testCatalog.code,
              display: item.testCatalog.name,
            }],
          },
          testName: item.testCatalog.name,
        })
        testCodesSet.add(item.testCatalog.code)
      }
    }
  })

  return {
    _id: prismaWorklist.id,
    type: 'worklist',
    date: prismaWorklist.generatedAt.toISOString().split('T')[0],
    mode: 'auto',
    instrumentId: prismaWorklist.instrumentId,
    section: prismaWorklist.section,
    priority: prismaWorklist.priority,
    status: prismaWorklist.status,
    testCodes: Array.from(testCodesSet),
    orders: Array.from(orderMap.values()),
    specimens: [], // Specimens would need to be fetched separately
    generatedAt: prismaWorklist.generatedAt.toISOString(),
    completedAt: prismaWorklist.completedAt?.toISOString(),
    createdAt: prismaWorklist.createdAt?.toISOString(),
    updatedAt: prismaWorklist.updatedAt?.toISOString(),
  }
}

