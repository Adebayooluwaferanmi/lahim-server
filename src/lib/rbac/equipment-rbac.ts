/**
 * Equipment RBAC/ACL Authorization
 * Handles role-based access control and ACL checks for equipment operations
 */

import { FastifyRequest, FastifyReply } from 'fastify'
import { FastifyInstance } from 'fastify'

export type EquipmentRole = 'equipment:manager' | 'equipment:technician'

export interface UserContext {
  id: string
  roles: string[]
  groups?: string[]
}

/**
 * Extract user context from request
 * This is a placeholder - adjust based on your auth implementation
 */
function getUserContext(request: FastifyRequest): UserContext | null {
  // TODO: Extract from JWT token, session, or request headers
  // For now, return a mock user for development
  // In production, this should extract from authenticated session
  const userId = (request.headers['x-user-id'] as string) || 'system'
  const userRoles = (request.headers['x-user-roles'] as string)?.split(',') || []
  const userGroups = (request.headers['x-user-groups'] as string)?.split(',').filter(Boolean) || []

  return {
    id: userId,
    roles: userRoles,
    groups: userGroups,
  }
}

/**
 * Check if user has required role
 */
function hasRole(user: UserContext | null, requiredRoles: EquipmentRole[]): boolean {
  if (!user) return false
  return requiredRoles.some((role) => user.roles.includes(role))
}

/**
 * Check if user has ACL access to equipment
 */
async function hasACLAccess(
  _fastify: FastifyInstance,
  user: UserContext | null,
  equipment: any,
  requiredRole?: string
): Promise<boolean> {
  if (!user || !equipment) return false

  // If no ACLs defined, allow access (backward compatibility)
  if (!equipment.acls || equipment.acls.length === 0) {
    return true
  }

  // Check ACL entries
  for (const acl of equipment.acls) {
    // Check user ID match
    if (acl.userId && acl.userId === user.id) {
      if (!requiredRole || acl.role === requiredRole) {
        return true
      }
    }

    // Check group match
    if (acl.groupId && user.groups && user.groups.includes(acl.groupId)) {
      if (!requiredRole || acl.role === requiredRole) {
        return true
      }
    }
  }

  return false
}

/**
 * RBAC/ACL authorization hook factory
 */
export function createEquipmentAuthHook(
  requiredRoles: EquipmentRole[],
  requireACL: boolean = true
) {
  return async (
    request: FastifyRequest<{ Params: { id?: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    const user = getUserContext(request)
    const fastifyInstance = request.server as FastifyInstance

    // Check role
    if (!hasRole(user, requiredRoles)) {
      fastifyInstance.log.warn(
        { userId: user?.id, requiredRoles, userRoles: user?.roles },
        'equipment.authz.role_denied'
      )
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions. Required roles: ' + requiredRoles.join(', '),
      })
      return
    }

    // If equipmentId provided, check ACL
    if (requireACL && request.params?.id) {
      const equipmentId = request.params.id

      try {
        if (!fastifyInstance.couchAvailable || !fastifyInstance.couch) {
          reply.code(503).send({ error: 'CouchDB is not available' })
          return
        }

        const equipmentDb = fastifyInstance.couch.db.use('equipment')
        const equipment = await equipmentDb.get(equipmentId).catch(() => null)

        if (!equipment || (equipment as any).type !== 'equipment') {
          reply.code(404).send({ error: 'Equipment not found' })
          return
        }

        // Check ACL access
        const hasAccess = await hasACLAccess(fastifyInstance, user, equipment as any)

        if (!hasAccess) {
          const fastifyInstance = request.server as FastifyInstance
          fastifyInstance.log.warn(
            { userId: user?.id, equipmentId },
            'equipment.authz.acl_denied'
          )
          reply.code(403).send({
            error: 'Forbidden',
            message: 'Access denied. You do not have permission to access this equipment.',
          })
          return
        }

        // Attach equipment to request for use in handlers
        ;(request as any).equipment = equipment
      } catch (error) {
        const fastifyInstance = request.server as FastifyInstance
        fastifyInstance.log.error({ error, equipmentId }, 'equipment.authz.check_failed')
        reply.code(500).send({ error: 'Failed to verify access' })
        return
      }
    }
  }
}

/**
 * Simple role check hook (no ACL)
 */
export function requireEquipmentRole(requiredRoles: EquipmentRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = getUserContext(request)

    if (!hasRole(user, requiredRoles)) {
      const fastify = request.server as FastifyInstance
      fastify.log.warn(
        { userId: user?.id, requiredRoles, userRoles: user?.roles },
        'equipment.authz.role_denied'
      )
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions. Required roles: ' + requiredRoles.join(', '),
      })
      return
    }
  }
}

