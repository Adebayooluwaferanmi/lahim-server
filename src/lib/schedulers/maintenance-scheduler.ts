/**
 * Maintenance Scheduler
 * Daily cron job to check for due/overdue maintenance and send notifications
 */

import { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { addDays, isBefore, parseISO } from 'date-fns'

interface MaintenanceNotification {
  equipmentId: string
  equipmentName: string
  nextDue: string
  status: 'overdue' | 'dueSoon'
  managers: string[] // User IDs from ACL
}

interface JobMetrics {
  total: number
  overdueCount: number
  dueSoonCount: number
  notificationsCreated: number
  emailsSent: number
  failures: number
  timestamp: string
}

/**
 * Get equipment managers from ACL
 */
function getEquipmentManagers(equipment: any): string[] {
  const managers: string[] = []
  if (!equipment.acls || equipment.acls.length === 0) {
    return managers
  }

  for (const acl of equipment.acls) {
    if (acl.role === 'equipment:manager' || acl.role === 'manager') {
      if (acl.userId) {
        managers.push(acl.userId)
      }
      // TODO: Resolve group members if groupId is provided
    }
  }

  return managers
}

/**
 * Create in-app notification
 */
async function createInAppNotification(
  fastify: FastifyInstance,
  userId: string,
  notification: MaintenanceNotification
): Promise<void> {
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.debug('CouchDB not available - skipping notification creation')
    return
  }

  try {
    const notificationsDb = fastify.couch.db.use('notifications')

    // Ensure database exists
    try {
      await fastify.couch.db.create('notifications')
    } catch (error: any) {
      if (!error?.message?.includes('file_exists') && !error?.message?.includes('already exists')) {
        fastify.log.warn({ error }, 'Failed to create notifications database')
      }
    }

    const notificationDoc = {
      _id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'notification',
      userId,
      status: 'unread',
      title: `Maintenance ${notification.status === 'overdue' ? 'Overdue' : 'Due Soon'}: ${notification.equipmentName}`,
      message: `Equipment "${notification.equipmentName}" has maintenance ${notification.status === 'overdue' ? 'overdue' : 'due soon'}. Next due: ${new Date(notification.nextDue).toLocaleDateString()}`,
      link: `/equipment/${notification.equipmentId}`,
      linkText: 'View Equipment',
      relatedEntityType: 'equipment',
      relatedEntityId: notification.equipmentId,
      channels: ['In-App'],
      priority: notification.status === 'overdue' ? 'High' : 'Normal',
      createdAt: new Date().toISOString(),
    }

    await notificationsDb.insert(notificationDoc)
    fastify.log.debug({ userId, equipmentId: notification.equipmentId }, 'maintenance.notification.created')
  } catch (error) {
    fastify.log.warn({ error, userId, equipmentId: notification.equipmentId }, 'maintenance.notification.create_failed')
    throw error
  }
}

/**
 * Process due/overdue maintenance notifications
 */
async function processMaintenanceNotifications(fastify: FastifyInstance, windowDays: number = 7): Promise<JobMetrics> {
  const metrics: JobMetrics = {
    total: 0,
    overdueCount: 0,
    dueSoonCount: 0,
    notificationsCreated: 0,
    emailsSent: 0,
    failures: 0,
    timestamp: new Date().toISOString(),
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('CouchDB not available - skipping maintenance notification job')
    return metrics
  }

  try {
    const db = fastify.couch.db.use('equipment')
    const today = new Date()
    const soon = addDays(today, windowDays)

    // Query equipment with maintenance plans due within window
    const selector: any = {
      type: 'equipment',
      active: true,
      'maintenancePlan.enabled': true,
      'maintenancePlan.nextDue': { $lte: soon.toISOString() },
    }

    const result = await db.find({
      selector,
      sort: [{ 'maintenancePlan.nextDue': 'asc' }],
    })

    metrics.total = result.docs.length

    for (const equipment of result.docs) {
      try {
        const nextDue = (equipment as any).maintenancePlan?.nextDue
        if (!nextDue) continue

        const dueDate = parseISO(nextDue)
        const status: 'overdue' | 'dueSoon' = isBefore(dueDate, today) ? 'overdue' : 'dueSoon'

        if (status === 'overdue') {
          metrics.overdueCount++
        } else {
          metrics.dueSoonCount++
        }

        const managers = getEquipmentManagers(equipment)

        const notification: MaintenanceNotification = {
          equipmentId: equipment._id,
          equipmentName: (equipment as any).name || 'Unknown Equipment',
          nextDue,
          status,
          managers,
        }

        // Create in-app notifications for managers
        for (const managerId of managers) {
          try {
            await createInAppNotification(fastify, managerId, notification)
            metrics.notificationsCreated++
          } catch (error) {
            fastify.log.warn({ error, managerId, equipmentId: equipment._id }, 'Failed to create notification')
            metrics.failures++
          }
        }

        // Send email notifications
        // TODO: Resolve email addresses from user IDs
        // For now, skip email if we can't resolve emails
        // In production, you'd fetch user emails from user service

      } catch (error) {
        fastify.log.warn({ error, equipmentId: equipment._id }, 'Failed to process equipment notification')
        metrics.failures++
      }
    }

    fastify.log.info(metrics, 'maintenance.notifications.processed')
  } catch (error) {
    fastify.log.error({ error }, 'maintenance.notifications.job_failed')
    metrics.failures++
  }

  return metrics
}

/**
 * Initialize and start the maintenance scheduler
 */
export function initializeMaintenanceScheduler(fastify: FastifyInstance): void {
  // Schedule daily at 02:00 local time
  const cronExpression = '0 2 * * *' // 2 AM every day

  cron.schedule(cronExpression, async () => {
    fastify.log.info('Starting maintenance notification job')
    const metrics = await processMaintenanceNotifications(fastify, 7)
    fastify.log.info(metrics, 'Maintenance notification job completed')
  })

  fastify.log.info('Maintenance scheduler initialized (runs daily at 02:00 local time)')
}

