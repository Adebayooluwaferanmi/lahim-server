/**
 * Mapper for Practitioner entities between CouchDB and Prisma
 */

export interface CouchPractitioner {
  _id?: string
  _rev?: string
  type?: string
  practitionerId?: string
  id?: string
  firstName?: string
  lastName?: string
  title?: string
  department?: string
  name?: string // Full name field
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB practitioner document to Prisma Practitioner input
 */
export function mapCouchToPrismaPractitioner(couchDoc: CouchPractitioner): {
  id: string
  practitionerId: string
  firstName?: string
  lastName?: string
  title?: string
  department?: string
} {
  // Extract practitionerId from various possible fields
  const practitionerId = couchDoc.practitionerId || couchDoc.id || couchDoc._id || ''
  
  // If name is provided as full name, try to split it
  let firstName = couchDoc.firstName
  let lastName = couchDoc.lastName
  
  if (!firstName && !lastName && couchDoc.name) {
    const nameParts = couchDoc.name.trim().split(/\s+/)
    if (nameParts.length > 0) {
      firstName = nameParts[0]
      lastName = nameParts.slice(1).join(' ') || undefined
    }
  }

  return {
    id: couchDoc._id || '',
    practitionerId: practitionerId,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    title: couchDoc.title || undefined,
    department: couchDoc.department || undefined,
  }
}

/**
 * Map Prisma Practitioner to CouchDB document structure
 */
export function mapPrismaToCouchPractitioner(
  prismaPractitioner: any,
  existingCouchDoc?: CouchPractitioner
): CouchPractitioner {
  const baseDoc: CouchPractitioner = existingCouchDoc || {
    type: 'practitioner',
  }

  return {
    ...baseDoc,
    _id: prismaPractitioner.id,
    practitionerId: prismaPractitioner.practitionerId,
    firstName: prismaPractitioner.firstName || baseDoc.firstName,
    lastName: prismaPractitioner.lastName || baseDoc.lastName,
    title: prismaPractitioner.title || baseDoc.title,
    department: prismaPractitioner.department || baseDoc.department,
    name: [prismaPractitioner.firstName, prismaPractitioner.lastName].filter(Boolean).join(' ') || baseDoc.name,
    updatedAt: new Date().toISOString(),
  }
}

