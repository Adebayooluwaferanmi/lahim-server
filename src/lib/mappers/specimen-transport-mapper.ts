/**
 * Specimen Transport Mapper
 * Maps between CouchDB and Prisma formats for Specimen Transport
 */

export interface CouchSpecimenTransport {
  _id: string
  _rev?: string
  type: 'specimen_transport'
  specimenId: string
  orderId: string
  transportType: 'internal' | 'external' | 'courier'
  origin: string
  destination: string
  carrier?: string
  trackingNumber?: string
  status: 'scheduled' | 'in-transit' | 'delivered' | 'failed' | 'cancelled'
  temperature?: number
  scheduledAt: string // ISO date string
  pickedUpAt?: string // ISO date string
  deliveredAt?: string // ISO date string
  cost?: number
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export function mapCouchToPrismaSpecimenTransport(
  couchDoc: CouchSpecimenTransport
): {
  id: string
  specimenId: string
  orderId: string
  transportType: string
  origin: string
  destination: string
  carrier?: string
  trackingNumber?: string
  status: string
  temperature?: number
  scheduledAt: Date
  pickedUpAt?: Date
  deliveredAt?: Date
  cost?: number
  notes?: string
} {
  return {
    id: couchDoc._id,
    specimenId: couchDoc.specimenId,
    orderId: couchDoc.orderId,
    transportType: couchDoc.transportType,
    origin: couchDoc.origin,
    destination: couchDoc.destination,
    carrier: couchDoc.carrier,
    trackingNumber: couchDoc.trackingNumber,
    status: couchDoc.status || 'scheduled',
    temperature: couchDoc.temperature,
    scheduledAt: new Date(couchDoc.scheduledAt),
    pickedUpAt: couchDoc.pickedUpAt ? new Date(couchDoc.pickedUpAt) : undefined,
    deliveredAt: couchDoc.deliveredAt ? new Date(couchDoc.deliveredAt) : undefined,
    cost: couchDoc.cost,
    notes: couchDoc.notes,
  }
}

export function mapPrismaToCouchSpecimenTransport(
  prismaData: {
    id: string
    specimenId: string
    orderId: string
    transportType: string
    origin: string
    destination: string
    carrier?: string
    trackingNumber?: string
    status: string
    temperature?: number
    scheduledAt: Date
    pickedUpAt?: Date
    deliveredAt?: Date
    cost?: number
    notes?: string
    createdAt: Date
    updatedAt: Date
  },
  rev?: string
): CouchSpecimenTransport {
  return {
    _id: prismaData.id,
    _rev: rev,
    type: 'specimen_transport',
    specimenId: prismaData.specimenId,
    orderId: prismaData.orderId,
    transportType: prismaData.transportType as 'internal' | 'external' | 'courier',
    origin: prismaData.origin,
    destination: prismaData.destination,
    carrier: prismaData.carrier,
    trackingNumber: prismaData.trackingNumber,
    status: prismaData.status as 'scheduled' | 'in-transit' | 'delivered' | 'failed' | 'cancelled',
    temperature: prismaData.temperature,
    scheduledAt: prismaData.scheduledAt.toISOString(),
    pickedUpAt: prismaData.pickedUpAt?.toISOString(),
    deliveredAt: prismaData.deliveredAt?.toISOString(),
    cost: prismaData.cost,
    notes: prismaData.notes,
    createdAt: prismaData.createdAt.toISOString(),
    updatedAt: prismaData.updatedAt.toISOString(),
  }
}

