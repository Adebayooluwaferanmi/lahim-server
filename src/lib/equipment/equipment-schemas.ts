/**
 * Equipment Validation Schemas
 * Zod schemas for validating equipment-related payloads
 */

import { z } from 'zod'

// Maintenance Plan Schema
export const MaintenancePlanSchema = z.object({
  kind: z.enum(['weekly', 'monthly', 'custom']),
  intervalValue: z.number().positive(),
  intervalUnit: z.enum(['days', 'weeks', 'months']),
  lastDate: z.string().datetime().optional(),
  enabled: z.boolean().default(true),
  // nextDue is computed server-side, never accepted from client
})

// Support Contact Schema
export const SupportSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  contact: z.string().optional(),
})

// Document Reference Schema
export const DocumentRefSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().nonnegative(),
  storageKey: z.string().min(1),
  uploadedAt: z.string().datetime(),
  uploadedBy: z.string().min(1),
})

// ACL Entry Schema
export const ACLEntrySchema = z.object({
  userId: z.string().optional(),
  groupId: z.string().optional(),
  role: z.string().min(1),
}).refine(
  (data: { userId?: string; groupId?: string }) => data.userId || data.groupId,
  { message: 'Either userId or groupId must be provided' }
)

// Equipment Create/Update Schema
export const EquipmentCreateUpdateSchema = z.object({
  name: z.string().min(1),
  vendorId: z.string().optional(),
  vendorName: z.string().optional(), // Denormalized for quick access
  support: SupportSchema.optional(),
  documents: z.array(DocumentRefSchema).optional(),
  maintenancePlan: MaintenancePlanSchema.optional(),
  acls: z.array(ACLEntrySchema).optional(),
  // Legacy fields for backward compatibility
  equipmentType: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(['active', 'maintenance', 'retired', 'decommissioned']).optional(),
  purchaseDate: z.string().datetime().optional(),
  warrantyExpiry: z.string().datetime().optional(),
  lastMaintenance: z.string().datetime().optional(),
  nextMaintenance: z.string().datetime().optional(),
})

// Document Attachment Schema
export const DocumentAttachmentSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().nonnegative(),
  storageKey: z.string().min(1),
  uploadedAt: z.string().datetime(),
  uploadedBy: z.string().min(1),
})

// Parts Used Schema
export const PartsUsedSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().positive(),
})

// Maintenance Event Schema
export const MaintenanceEventSchema = z.object({
  performedAt: z.string().datetime(),
  performerId: z.string().min(1),
  maintenanceType: z.enum(['routine', 'corrective', 'emergency']),
  notes: z.string().optional(),
  partsUsed: z.array(PartsUsedSchema).optional(),
  attachments: z.array(z.string()).optional(), // Document IDs
})

// Search Query Schema
export const EquipmentSearchQuerySchema = z.object({
  vendorId: z.string().optional(),
  active: z.boolean().optional(),
  dueInDays: z.number().nonnegative().optional(),
  text: z.string().optional(),
  skip: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(100).default(25),
  status: z.enum(['active', 'maintenance', 'retired', 'decommissioned']).optional(),
  equipmentType: z.string().optional(),
  location: z.string().optional(),
})

// Type exports
export type MaintenancePlan = z.infer<typeof MaintenancePlanSchema>
export type Support = z.infer<typeof SupportSchema>
export type DocumentRef = z.infer<typeof DocumentRefSchema>
export type ACLEntry = z.infer<typeof ACLEntrySchema>
export type EquipmentCreateUpdate = z.infer<typeof EquipmentCreateUpdateSchema>
export type DocumentAttachment = z.infer<typeof DocumentAttachmentSchema>
export type PartsUsed = z.infer<typeof PartsUsedSchema>
export type MaintenanceEvent = z.infer<typeof MaintenanceEventSchema>
export type EquipmentSearchQuery = z.infer<typeof EquipmentSearchQuerySchema>

