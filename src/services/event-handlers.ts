/**
 * Event Handlers Example
 * 
 * Demonstrates how to subscribe to events and handle them
 * This shows event-driven architecture patterns
 */

import { FastifyInstance } from 'fastify'
import { eventBus, DomainEvent } from '../lib/event-bus'
import { CacheHelper } from '../lib/db-utils'

/**
 * Initialize event handlers
 * Call this from app.ts or a plugin
 */
export function initializeEventHandlers(fastify: FastifyInstance) {
  const cache = new CacheHelper(fastify.redis)

  // Example: Invalidate cache when lab order is updated
  eventBus.subscribe('lab.order.created', async (event: DomainEvent) => {
    fastify.log.info({ orderId: event.aggregateId }, 'Lab order created event received')
    
    // Invalidate cache
    await cache.deletePattern('lab-orders:*')
    
    // Could also:
    // - Send notification
    // - Update analytics
    // - Trigger workflow
  })

  eventBus.subscribe('lab.order.updated', async (event: DomainEvent) => {
    fastify.log.info({ orderId: event.aggregateId }, 'Lab order updated event received')
    
    // Invalidate specific cache entry
    await cache.delete(`lab-order:${event.aggregateId}`)
    await cache.deletePattern('lab-orders:*')
  })

  eventBus.subscribe('lab.order.completed', async (event: DomainEvent) => {
    fastify.log.info({ orderId: event.aggregateId }, 'Lab order completed event received')
    
    // Example: Send notification
    // await sendNotification({
    //   type: 'lab-order-completed',
    //   orderId: event.aggregateId,
    //   data: event.data,
    // })
  })

  eventBus.subscribe('lab.result.finalized', async (event: DomainEvent) => {
    fastify.log.info({ resultId: event.aggregateId }, 'Lab result finalized event received')
    
    // Example: Check for critical values
    // const result = event.data
    // if (result.isCritical) {
    //   await sendCriticalValueAlert(result)
    // }
  })

  eventBus.subscribe('qc.result.failed', async (event: DomainEvent) => {
    fastify.log.warn({ qcId: event.aggregateId }, 'QC result failed event received')
    
    // Example: Lock results, send alert
    // await lockResultsForQC(event.aggregateId)
    // await sendQCAlert(event.data)
  })

  fastify.log.info('Event handlers initialized')
}

/**
 * Example: Analytics event handler
 * Could send events to analytics service
 */
export function initializeAnalyticsHandlers(fastify: FastifyInstance) {
  // Subscribe to all events for analytics
  const eventTypes: string[] = [
    'lab.order.created',
    'lab.order.completed',
    'lab.result.finalized',
  ]

  eventTypes.forEach((eventType) => {
    eventBus.subscribe(eventType as any, async (event: DomainEvent) => {
      // Send to analytics service
      // await analyticsService.track(event)
      
      fastify.log.debug(
        { eventType, aggregateId: event.aggregateId },
        'Analytics event tracked'
      )
    })
  })
}

