/**
 * Mapper for Patient entities between CouchDB and Prisma
 */

export interface CouchPatient {
  _id?: string
  _rev?: string
  type?: string
  data?: {
    friendlyId?: string
    externalPatientId?: string
    firstName?: string
    lastName?: string
    dateOfBirth?: string
    sex?: string
    [key: string]: any
  }
  // Direct fields (if not nested in data)
  friendlyId?: string
  externalPatientId?: string
  firstName?: string
  lastName?: string
  dateOfBirth?: string
  sex?: string
  code?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Map CouchDB patient document to Prisma Patient input
 */
export function mapCouchToPrismaPatient(couchDoc: CouchPatient): {
  id: string
  patientId: string
  firstName?: string
  lastName?: string
  dateOfBirth?: Date
  sex?: string
} {
  // Handle both nested (data) and flat structures
  const data = couchDoc.data || couchDoc
  const patientId = data.friendlyId || data.externalPatientId || data.code || couchDoc._id || ''
  
  let dateOfBirth: Date | undefined
  if (data.dateOfBirth) {
    try {
      dateOfBirth = new Date(data.dateOfBirth)
      if (isNaN(dateOfBirth.getTime())) {
        dateOfBirth = undefined
      }
    } catch {
      dateOfBirth = undefined
    }
  }

  return {
    id: couchDoc._id || '',
    patientId: patientId,
    firstName: data.firstName || undefined,
    lastName: data.lastName || undefined,
    dateOfBirth: dateOfBirth,
    sex: data.sex || undefined,
  }
}

/**
 * Map Prisma Patient to CouchDB document structure
 */
export function mapPrismaToCouchPatient(
  prismaPatient: any,
  existingCouchDoc?: CouchPatient
): CouchPatient {
  const baseDoc: CouchPatient = existingCouchDoc || {
    type: 'patient',
    data: {},
  }

  return {
    ...baseDoc,
    _id: prismaPatient.id,
    data: {
      ...(baseDoc.data || {}),
      friendlyId: prismaPatient.patientId,
      externalPatientId: prismaPatient.patientId,
      firstName: prismaPatient.firstName || baseDoc.data?.firstName,
      lastName: prismaPatient.lastName || baseDoc.data?.lastName,
      dateOfBirth: prismaPatient.dateOfBirth?.toISOString() || baseDoc.data?.dateOfBirth,
      sex: prismaPatient.sex || baseDoc.data?.sex,
    },
    updatedAt: new Date().toISOString(),
  }
}

