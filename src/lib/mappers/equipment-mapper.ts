/**
 * Equipment Mapper
 * Maps between CouchDB and Prisma formats for Equipment
 */

export interface CouchEquipment {
  _id: string
  _rev?: string
  type: 'equipment'
  name: string
  equipmentType: string // analyzer, centrifuge, microscope, refrigerator, freezer, etc.
  manufacturer?: string
  model?: string
  serialNumber?: string
  location?: string
  status: 'active' | 'maintenance' | 'retired' | 'decommissioned'
  purchaseDate?: string // ISO date string
  warrantyExpiry?: string // ISO date string
  lastMaintenance?: string // ISO date string
  nextMaintenance?: string // ISO date string
  createdAt?: string
  updatedAt?: string
}

export interface CouchEquipmentMaintenance {
  _id: string
  _rev?: string
  type: 'equipment_maintenance'
  equipmentId: string
  maintenanceType: 'preventive' | 'corrective' | 'calibration' | 'repair'
  scheduledAt: string // ISO date string
  performedAt?: string // ISO date string
  performedBy?: string
  cost?: number
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export function mapCouchToPrismaEquipment(
  couchDoc: CouchEquipment
): {
  id: string
  name: string
  type: string
  manufacturer?: string
  model?: string
  serialNumber?: string
  location?: string
  status: string
  purchaseDate?: Date
  warrantyExpiry?: Date
  lastMaintenance?: Date
  nextMaintenance?: Date
} {
  return {
    id: couchDoc._id,
    name: couchDoc.name,
    type: couchDoc.equipmentType,
    manufacturer: couchDoc.manufacturer,
    model: couchDoc.model,
    serialNumber: couchDoc.serialNumber,
    location: couchDoc.location,
    status: couchDoc.status || 'active',
    purchaseDate: couchDoc.purchaseDate ? new Date(couchDoc.purchaseDate) : undefined,
    warrantyExpiry: couchDoc.warrantyExpiry ? new Date(couchDoc.warrantyExpiry) : undefined,
    lastMaintenance: couchDoc.lastMaintenance ? new Date(couchDoc.lastMaintenance) : undefined,
    nextMaintenance: couchDoc.nextMaintenance ? new Date(couchDoc.nextMaintenance) : undefined,
  }
}

export function mapPrismaToCouchEquipment(
  prismaData: {
    id: string
    name: string
    type: string
    manufacturer?: string
    model?: string
    serialNumber?: string
    location?: string
    status: string
    purchaseDate?: Date
    warrantyExpiry?: Date
    lastMaintenance?: Date
    nextMaintenance?: Date
    createdAt: Date
    updatedAt: Date
  },
  rev?: string
): CouchEquipment {
  return {
    _id: prismaData.id,
    _rev: rev,
    type: 'equipment',
    name: prismaData.name,
    equipmentType: prismaData.type,
    manufacturer: prismaData.manufacturer,
    model: prismaData.model,
    serialNumber: prismaData.serialNumber,
    location: prismaData.location,
    status: prismaData.status as 'active' | 'maintenance' | 'retired' | 'decommissioned',
    purchaseDate: prismaData.purchaseDate?.toISOString(),
    warrantyExpiry: prismaData.warrantyExpiry?.toISOString(),
    lastMaintenance: prismaData.lastMaintenance?.toISOString(),
    nextMaintenance: prismaData.nextMaintenance?.toISOString(),
    createdAt: prismaData.createdAt.toISOString(),
    updatedAt: prismaData.updatedAt.toISOString(),
  }
}

export function mapCouchToPrismaEquipmentMaintenance(
  couchDoc: CouchEquipmentMaintenance
): {
  id: string
  equipmentId: string
  type: string
  scheduledAt: Date
  performedAt?: Date
  performedBy?: string
  cost?: number
  notes?: string
} {
  return {
    id: couchDoc._id,
    equipmentId: couchDoc.equipmentId,
    type: couchDoc.maintenanceType,
    scheduledAt: new Date(couchDoc.scheduledAt),
    performedAt: couchDoc.performedAt ? new Date(couchDoc.performedAt) : undefined,
    performedBy: couchDoc.performedBy,
    cost: couchDoc.cost,
    notes: couchDoc.notes,
  }
}

export function mapPrismaToCouchEquipmentMaintenance(
  prismaData: {
    id: string
    equipmentId: string
    type: string
    scheduledAt: Date
    performedAt?: Date
    performedBy?: string
    cost?: number
    notes?: string
    createdAt: Date
    updatedAt: Date
  },
  rev?: string
): CouchEquipmentMaintenance {
  return {
    _id: prismaData.id,
    _rev: rev,
    type: 'equipment_maintenance',
    equipmentId: prismaData.equipmentId,
    maintenanceType: prismaData.type as 'preventive' | 'corrective' | 'calibration' | 'repair',
    scheduledAt: prismaData.scheduledAt.toISOString(),
    performedAt: prismaData.performedAt?.toISOString(),
    performedBy: prismaData.performedBy,
    cost: prismaData.cost,
    notes: prismaData.notes,
    createdAt: prismaData.createdAt.toISOString(),
    updatedAt: prismaData.updatedAt.toISOString(),
  }
}

