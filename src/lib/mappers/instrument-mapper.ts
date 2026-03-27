/**
 * Mapper for Instrument entities between CouchDB and Prisma
 */

export interface CouchInstrument {
  _id?: string
  _rev?: string
  type: 'instrument'
  name: string
  instrumentType?: string // CouchDB field name
  manufacturer?: string
  model?: string
  serialNumber?: string
  status?: string // online, offline, maintenance
  section?: string // Hematology, Chemistry, Microbiology, etc.
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB instrument document to Prisma Instrument input
 */
export function mapCouchToPrismaInstrument(couchDoc: CouchInstrument): {
  id: string
  name: string
  type: string
  manufacturer?: string
  model?: string
  serialNumber?: string
  status: string
  section?: string
} {
  return {
    id: couchDoc._id || '',
    name: couchDoc.name,
    type: couchDoc.instrumentType || couchDoc.type || 'analyzer',
    manufacturer: couchDoc.manufacturer || undefined,
    model: couchDoc.model || undefined,
    serialNumber: couchDoc.serialNumber || undefined,
    status: couchDoc.status || 'offline',
    section: couchDoc.section || undefined,
  }
}

/**
 * Map Prisma Instrument to CouchDB document structure
 */
export function mapPrismaToCouchInstrument(
  prismaInstrument: any,
  existingCouchDoc?: CouchInstrument
): CouchInstrument {
  const baseDoc: CouchInstrument = existingCouchDoc || {
    type: 'instrument',
    name: prismaInstrument.name,
  }

  return {
    ...baseDoc,
    _id: prismaInstrument.id,
    name: prismaInstrument.name,
    instrumentType: prismaInstrument.type,
    manufacturer: prismaInstrument.manufacturer || baseDoc.manufacturer,
    model: prismaInstrument.model || baseDoc.model,
    serialNumber: prismaInstrument.serialNumber || baseDoc.serialNumber,
    status: prismaInstrument.status || baseDoc.status || 'offline',
    section: prismaInstrument.section || baseDoc.section,
    updatedAt: new Date().toISOString(),
  }
}

