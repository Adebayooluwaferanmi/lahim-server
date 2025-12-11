import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { randomUUID } from 'crypto'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure database exists
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'notifications')
    await ensureCouchDBDatabase(fastify, 'notification_preferences')
  }

  // Only create database reference if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Notifications service: CouchDB not available - endpoints will return errors')
    return
  }

  const notificationsDb = fastify.couch.db.use('notifications')
  const preferencesDb = fastify.couch.db.use('notification_preferences')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'notifications',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'userId'] }, name: 'type-userId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'createdAt'] }, name: 'type-createdAt-index' },
      { index: { fields: ['userId'] }, name: 'userId-index' },
      { index: { fields: ['userId', 'status'] }, name: 'userId-status-index' },
      { index: { fields: ['status'] }, name: 'status-index' },
      { index: { fields: ['createdAt'] }, name: 'createdAt-index' },
    ],
    'Notifications'
  )

  createCouchDBIndexes(
    fastify,
    'notification_preferences',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'userId'] }, name: 'type-userId-index' },
      { index: { fields: ['userId'] }, name: 'userId-index' },
    ],
    'Notification Preferences'
  )

  // Helper function to send notification via channels
  const sendNotification = async (notification: any, preferences?: any) => {
    const channels = notification.channels || ['In-App']
    const sentChannels: string[] = []

    // Get user preferences if available
    const userPrefs = preferences || await getUserPreferences(notification.userId)

    for (const channel of channels) {
      try {
        switch (channel) {
          case 'In-App':
            // In-app notifications are stored in the database
            sentChannels.push('In-App')
            break
          case 'Email':
            if (userPrefs?.emailEnabled !== false) {
              // TODO: Implement email sending
              fastify.log.info({ notificationId: notification._id, userId: notification.userId }, 'notification.email.sent')
              sentChannels.push('Email')
            }
            break
          case 'SMS':
            if (userPrefs?.smsEnabled !== false) {
              // TODO: Implement SMS sending
              fastify.log.info({ notificationId: notification._id, userId: notification.userId }, 'notification.sms.sent')
              sentChannels.push('SMS')
            }
            break
          case 'Push':
            if (userPrefs?.pushEnabled !== false) {
              // TODO: Implement push notification
              fastify.log.info({ notificationId: notification._id, userId: notification.userId }, 'notification.push.sent')
              sentChannels.push('Push')
            }
            break
        }
      } catch (error) {
        fastify.log.error({ error, channel, notificationId: notification._id }, 'notification.send_failed')
      }
    }

    return sentChannels
  }

  // Helper function to get user preferences
  const getUserPreferences = async (userId: string) => {
    try {
      const result = await preferencesDb.find({
        selector: {
          type: 'notification_preference',
          userId,
        },
        limit: 1,
      })

      if (result.docs.length > 0) {
        return result.docs[0] as any
      }

      // Return default preferences
      return {
        emailEnabled: true,
        smsEnabled: false,
        pushEnabled: true,
        inAppEnabled: true,
      }
    } catch (error) {
      fastify.log.warn({ error, userId }, 'Failed to get user preferences, using defaults')
      return {
        emailEnabled: true,
        smsEnabled: false,
        pushEnabled: true,
        inAppEnabled: true,
      }
    }
  }

  // ========== NOTIFICATIONS ==========

  // GET /notifications - List notifications for current user
  fastify.get('/notifications', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, status, type, userId } = request.query as any
      const selector: any = { type: 'notification' }

      // Use userId from query or get from auth context
      const targetUserId = userId || (request as any).user?.id
      if (targetUserId) {
        selector.userId = targetUserId
      }

      if (status) selector.status = status
      if (type) selector.type = type

      const result = await notificationsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ createdAt: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'notifications.list')
      reply.send({ notifications: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notifications.list_failed')
      reply.code(500).send({ error: 'Failed to list notifications' })
    }
  })

  // GET /notifications/unread - Get unread notifications count
  fastify.get('/notifications/unread', async (request, reply) => {
    try {
      const userId = (request as any).user?.id || (request.query as any).userId || 'system'
      // Use 'system' as default for now if no user context

      const result = await notificationsDb.find({
        selector: {
          type: 'notification',
          userId,
          status: 'Unread',
        },
        limit: 1000, // Get all unread to count
      })

      fastify.log.debug({ userId, count: result.docs.length }, 'notifications.unread_count')
      reply.send({ count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notifications.unread_count_failed')
      reply.code(500).send({ error: 'Failed to get unread count' })
    }
  })

  // GET /notifications/:id - Get single notification
  fastify.get('/notifications/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await notificationsDb.get(id)

      if ((doc as any).type !== 'notification') {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }

      fastify.log.debug({ id }, 'notifications.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'notifications.get_failed')
      reply.code(500).send({ error: 'Failed to get notification' })
    }
  })

  // POST /notifications - Create notification
  fastify.post('/notifications', async (request, reply) => {
    try {
      const notificationData = request.body as any

      if (!notificationData.userId || !notificationData.title || !notificationData.message) {
        reply.code(400).send({ error: 'User ID, title, and message are required' })
        return
      }

      const now = new Date().toISOString()
      const notificationDoc = {
        _id: `notification_${Date.now()}_${randomUUID()}`,
        type: 'notification',
        userId: notificationData.userId,
        notificationType: notificationData.type || 'Info',
        status: 'Unread',
        title: notificationData.title,
        message: notificationData.message,
        link: notificationData.link,
        linkText: notificationData.linkText,
        relatedEntityType: notificationData.relatedEntityType,
        relatedEntityId: notificationData.relatedEntityId,
        channels: notificationData.channels || ['In-App'],
        sentChannels: [],
        readAt: notificationData.readAt,
        archivedAt: notificationData.archivedAt,
        expiresAt: notificationData.expiresAt,
        priority: notificationData.priority || 'Normal',
        actions: notificationData.actions || [],
        createdAt: now,
        updatedAt: now,
      }

      const result = await notificationsDb.insert(notificationDoc)

      // Send notification via configured channels
      const sentChannels = await sendNotification(notificationDoc)
      if (sentChannels.length > 0) {
        notificationDoc.sentChannels = sentChannels as any
        await notificationsDb.insert(notificationDoc)
      }

      // Emit real-time notification via Socket.io
      if (fastify.io) {
        fastify.io.to(`user:${notificationData.userId}`).emit('notification:new', {
          id: result.id,
          ...notificationDoc,
        })
      }

      // Publish event
      const { eventBus } = require('../lib/event-bus')
      eventBus.publish('notification.created', {
        id: result.id,
        userId: notificationData.userId,
        type: notificationData.type,
      })

      fastify.log.info({ id: result.id, userId: notificationData.userId }, 'notifications.created')
      reply.code(201).send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notifications.create_failed')
      reply.code(500).send({ error: 'Failed to create notification' })
    }
  })

  // PUT /notifications/:id - Update notification
  fastify.put('/notifications/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await notificationsDb.get(id)
      if ((existing as any).type !== 'notification') {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }

      const now = new Date().toISOString()
      const updated = {
        ...existing,
        ...updates,
        updatedAt: now,
      }

      // Auto-update readAt when status changes to Read
      if (updates.status === 'Read' && !(existing as any).readAt) {
        updated.readAt = now
      }

      // Auto-update archivedAt when status changes to Archived
      if (updates.status === 'Archived' && !(existing as any).archivedAt) {
        updated.archivedAt = now
      }

      const result = await notificationsDb.insert(updated)

      fastify.log.info({ id }, 'notifications.updated')
      reply.send({ id: result.id, rev: result.rev })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'notifications.update_failed')
      reply.code(500).send({ error: 'Failed to update notification' })
    }
  })

  // POST /notifications/:id/read - Mark notification as read
  fastify.post('/notifications/:id/read', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await notificationsDb.get(id)

      if ((doc as any).type !== 'notification') {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }

      const updated = {
        ...doc,
        status: 'Read',
        readAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await notificationsDb.insert(updated)

      fastify.log.info({ id }, 'notifications.marked_read')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'notifications.mark_read_failed')
      reply.code(500).send({ error: 'Failed to mark notification as read' })
    }
  })

  // POST /notifications/read-all - Mark all notifications as read for user
  fastify.post('/notifications/read-all', async (request, reply) => {
    try {
      const userId = (request.body as any).userId || (request as any).user?.id
      if (!userId) {
        reply.code(400).send({ error: 'User ID is required' })
        return
      }

      const result = await notificationsDb.find({
        selector: {
          type: 'notification',
          userId,
          status: 'Unread',
        },
        limit: 1000,
      })

      const now = new Date().toISOString()
      const updates = result.docs.map((doc: any) => ({
        ...doc,
        status: 'Read',
        readAt: now,
        updatedAt: now,
      }))

      // Update all notifications
      for (const update of updates) {
        await notificationsDb.insert(update)
      }

      fastify.log.info({ userId, count: updates.length }, 'notifications.marked_all_read')
      reply.send({ success: true, count: updates.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notifications.mark_all_read_failed')
      reply.code(500).send({ error: 'Failed to mark all notifications as read' })
    }
  })

  // DELETE /notifications/:id - Delete notification
  fastify.delete('/notifications/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await notificationsDb.get(id)

      if ((doc as any).type !== 'notification') {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }

      await notificationsDb.destroy(id, (doc as any)._rev)

      fastify.log.info({ id }, 'notifications.deleted')
      reply.send({ success: true })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Notification not found' })
        return
      }
      fastify.log.error({ error: error as Error }, 'notifications.delete_failed')
      reply.code(500).send({ error: 'Failed to delete notification' })
    }
  })

  // ========== NOTIFICATION PREFERENCES ==========

  // GET /notifications/preferences/:userId - Get user preferences
  fastify.get('/notifications/preferences/:userId', async (request, reply) => {
    try {
      const { userId } = request.params as { userId: string }
      const result = await preferencesDb.find({
        selector: {
          type: 'notification_preference',
          userId,
        },
        limit: 1,
      })

      if (result.docs.length > 0) {
        reply.send(result.docs[0])
      } else {
        // Return default preferences
        reply.send({
          userId,
          emailEnabled: true,
          smsEnabled: false,
          pushEnabled: true,
          inAppEnabled: true,
        })
      }
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notification_preferences.get_failed')
      reply.code(500).send({ error: 'Failed to get preferences' })
    }
  })

  // PUT /notifications/preferences/:userId - Update user preferences
  fastify.put('/notifications/preferences/:userId', async (request, reply) => {
    try {
      const { userId } = request.params as { userId: string }
      const preferences = request.body as any

      const result = await preferencesDb.find({
        selector: {
          type: 'notification_preference',
          userId,
        },
        limit: 1,
      })

      const now = new Date().toISOString()
      let preferenceDoc: any

      if (result.docs.length > 0) {
        preferenceDoc = {
          ...result.docs[0],
          ...preferences,
          updatedAt: now,
        }
      } else {
        preferenceDoc = {
          _id: `notification_preference_${userId}_${Date.now()}`,
          type: 'notification_preference',
          userId,
          emailEnabled: preferences.emailEnabled !== undefined ? preferences.emailEnabled : true,
          smsEnabled: preferences.smsEnabled !== undefined ? preferences.smsEnabled : false,
          pushEnabled: preferences.pushEnabled !== undefined ? preferences.pushEnabled : true,
          inAppEnabled: preferences.inAppEnabled !== undefined ? preferences.inAppEnabled : true,
          preferencesByType: preferences.preferencesByType || {},
          createdAt: now,
          updatedAt: now,
        }
      }

      const insertResult = await preferencesDb.insert(preferenceDoc)

      fastify.log.info({ userId }, 'notification_preferences.updated')
      reply.send({ id: insertResult.id, rev: insertResult.rev })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'notification_preferences.update_failed')
      reply.code(500).send({ error: 'Failed to update preferences' })
    }
  })

}

