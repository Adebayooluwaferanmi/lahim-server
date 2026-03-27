/**
 * Mapping functions between CouchDB Specimen documents and Prisma LabSpecimen model
 */

export interface CouchSpecimen {
  _id?: string
  _rev?: string
  type: 'specimen'
  orderId: string
  patientId?: string
  specimenType?: {
    coding?: Array<{
      code: string
      system?: string
      display?: string
    }>
  }
  specimenTypeCode?: string
  collectedOn?: string
  container?: string
  accessionNo?: string
  storageLocation?: string
  status?: string
  aliquots?: any[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB specimen document to Prisma LabSpecimen input
 */
export function mapCouchToPrismaSpecimen(couchDoc: CouchSpecimen): {
  id: string
  orderId: string
  specimenTypeCode: string
  collectedAt: Date
  container?: string
  accessionNo: string
  storageLocation?: string
} {
  // Extract specimen type code
  let specimenTypeCode = couchDoc.specimenTypeCode || ''
  if (!specimenTypeCode && couchDoc.specimenType?.coding?.[0]?.code) {
    specimenTypeCode = couchDoc.specimenType.coding[0].code
  }
  if (!specimenTypeCode) {
    specimenTypeCode = 'UNKNOWN'
  }

  // Generate accession number if missing
  const accessionNo = couchDoc.accessionNo || `ACC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  return {
    id: couchDoc._id || '',
    orderId: couchDoc.orderId,
    specimenTypeCode,
    collectedAt: couchDoc.collectedOn ? new Date(couchDoc.collectedOn) : new Date(),
    container: couchDoc.container || undefined,
    accessionNo,
    storageLocation: couchDoc.storageLocation || undefined,
  }
}

/**
 * Map Prisma LabSpecimen to CouchDB document structure
 */
export function mapPrismaToCouchSpecimen(
  prismaSpecimen: any,
  existingCouchDoc?: CouchSpecimen
): CouchSpecimen {
  const baseDoc: CouchSpecimen = existingCouchDoc || {
    type: 'specimen',
    orderId: prismaSpecimen.orderId,
    specimenTypeCode: prismaSpecimen.specimenTypeCode,
  }

  return {
    ...baseDoc,
    _id: prismaSpecimen.id,
    orderId: prismaSpecimen.orderId,
    specimenTypeCode: prismaSpecimen.specimenTypeCode,
    collectedOn: prismaSpecimen.collectedAt?.toISOString() || baseDoc.collectedOn,
    container: prismaSpecimen.container || baseDoc.container,
    accessionNo: prismaSpecimen.accessionNo || baseDoc.accessionNo,
    storageLocation: prismaSpecimen.storageLocation || baseDoc.storageLocation,
    updatedAt: new Date().toISOString(),
  }
}

