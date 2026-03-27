/**
 * Mapper for TestCatalog entities between CouchDB and Prisma
 */

export interface CouchTestCatalog {
  _id?: string
  _rev?: string
  type: 'testCatalogEntry'
  code: string // LOINC code
  name: string
  department?: string
  active?: boolean
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB test catalog document to Prisma TestCatalog input
 */
export function mapCouchToPrismaTestCatalog(couchDoc: CouchTestCatalog): {
  id: string
  code: string
  name: string
  department?: string
  active: boolean
} {
  return {
    id: couchDoc._id || '',
    code: couchDoc.code,
    name: couchDoc.name,
    department: couchDoc.department || undefined,
    active: couchDoc.active !== undefined ? couchDoc.active : true,
  }
}

/**
 * Map Prisma TestCatalog to CouchDB document structure
 */
export function mapPrismaToCouchTestCatalog(
  prismaTestCatalog: any,
  existingCouchDoc?: CouchTestCatalog
): CouchTestCatalog {
  const baseDoc: CouchTestCatalog = existingCouchDoc || {
    type: 'testCatalogEntry',
    code: prismaTestCatalog.code,
    name: prismaTestCatalog.name,
  }

  return {
    ...baseDoc,
    _id: prismaTestCatalog.id,
    code: prismaTestCatalog.code,
    name: prismaTestCatalog.name,
    department: prismaTestCatalog.department || baseDoc.department,
    active: prismaTestCatalog.active !== undefined ? prismaTestCatalog.active : (baseDoc.active !== undefined ? baseDoc.active : true),
    updatedAt: new Date().toISOString(),
  }
}

