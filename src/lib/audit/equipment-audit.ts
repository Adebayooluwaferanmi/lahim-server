/**
 * Equipment Audit Logging
 * Tracks all write operations for equipment and maintenance records
 */

import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'

export interface AuditLog {
  _id: string
  type: 'equipment_audit'
  actorId: string
  action: string
  entityId: string
  entityType: 'equipment' | 'maintenance'
  before?: any
  after?: any
  at: string
  metadata?: Record<string, any>
}

/**
 * Get user ID from request context
 */
function getActorId(request: any): string {
  // TODO: Extract from authenticated session
  // For now, use header or default to 'system'
  return (request?.headers?.['x-user-id'] as string) || 'system'
}

/**
 * Write audit log entry
 */
export async function logEquipmentAudit(
  fastify: FastifyInstance,
  request: any,
  action: string,
  entityId: string,
  entityType: 'equipment' | 'maintenance',
  before?: any,
  after?: any,
  metadata?: Record<string, any>
): Promise<void> {
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.debug('CouchDB not available - skipping audit log')
    return
  }

  try {
    const actorId = getActorId(request)
    const auditDb = fastify.couch.db.use('equipment_audit')

    // Ensure database exists
    try {
      await fastify.couch.db.create('equipment_audit')
    } catch (error: any) {
      // Database already exists, which is fine
      if (!error?.message?.includes('file_exists') && !error?.message?.includes('already exists')) {
        fastify.log.warn({ error }, 'Failed to create equipment_audit database')
      }
    }

    const auditLog: AuditLog = {
      _id: `audit_${Date.now()}_${randomUUID()}`,
      type: 'equipment_audit',
      actorId,
      action,
      entityId,
      entityType,
      before: before ? JSON.parse(JSON.stringify(before)) : undefined,
      after: after ? JSON.parse(JSON.stringify(after)) : undefined,
      at: new Date().toISOString(),
      metadata,
    }

    await auditDb.insert(auditLog)
    fastify.log.debug({ action, entityId, actorId }, 'equipment.audit.logged')
  } catch (error) {
    // Don't fail the request if audit logging fails
    fastify.log.warn({ error, action, entityId }, 'equipment.audit.log_failed')
  }
}

/**
 * Audit helper for equipment operations
 */
export class EquipmentAuditHelper {
  constructor(
    private fastify: FastifyInstance,
    private request: any
  ) {}

  async logCreate(entityId: string, after: any): Promise<void> {
    await logEquipmentAudit(
      this.fastify,
      this.request,
      'create',
      entityId,
      'equipment',
      undefined,
      after
    )
  }

  async logUpdate(entityId: string, before: any, after: any): Promise<void> {
    await logEquipmentAudit(
      this.fastify,
      this.request,
      'update',
      entityId,
      'equipment',
      before,
      after
    )
  }

  async logAttachDocument(entityId: string, document: any): Promise<void> {
    await logEquipmentAudit(
      this.fastify,
      this.request,
      'attach-document',
      entityId,
      'equipment',
      undefined,
      undefined,
      { document }
    )
  }

  async logCreateMaintenance(entityId: string, maintenance: any): Promise<void> {
    await logEquipmentAudit(
      this.fastify,
      this.request,
      'create-maintenance',
      entityId,
      'maintenance',
      undefined,
      maintenance
    )
  }

  async logAuthzDeny(entityId: string | undefined, reason: string): Promise<void> {
    await logEquipmentAudit(
      this.fastify,
      this.request,
      'authz-deny',
      entityId || 'unknown',
      'equipment',
      undefined,
      undefined,
      { reason }
    )
  }
}

