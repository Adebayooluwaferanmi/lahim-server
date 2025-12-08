/**
 * Event Bus for Event-Driven Architecture
 * 
 * This is a simple in-memory event bus for now.
 * In production, this should be replaced with Kafka/Redpanda
 */

import { FastifyInstance } from 'fastify'

export type EventType = 
  | 'lab.order.created'
  | 'lab.order.updated'
  | 'lab.order.completed'
  | 'lab.result.created'
  | 'lab.result.updated'
  | 'lab.result.finalized'
  | 'lab.result.reviewed'
  | 'lab.result.addendum'
  | 'lab.result.correlation'
  | 'specimen.collected'
  | 'specimen.received'
  | 'specimen.processed'
  | 'worklist.generated'
  | 'worklist.completed'
  | 'qc.result.entered'
  | 'qc.result.failed'
  | 'critical-value.detected'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.deleted'
  | 'inventory.received'
  | 'inventory.issued'
  | 'inventory.transferred'
  | 'inventory.adjusted'
  | 'vocabulary.organism.created'
  | 'vocabulary.organism.updated'
  | 'vocabulary.organism.deleted'
  | 'vocabulary.antibiotic.created'
  | 'vocabulary.antibiotic.updated'
  | 'vocabulary.antibiotic.deleted'
  | 'vocabulary.value_set.created'
  | 'vocabulary.value_set.updated'
  | 'vocabulary.value_set.deleted'
  | 'specimen.transport.created'
  | 'specimen.transport.updated'
  | 'specimen.transport.tracked'
  | 'equipment.registered'
  | 'equipment.updated'
  | 'equipment.maintenance.scheduled'
  | 'equipment.maintenance.completed'

export interface DomainEvent {
  type: EventType
  aggregateId: string
  aggregateType: string
  data: any
  metadata: {
    timestamp: number
    userId?: string
    correlationId?: string
    causationId?: string
  }
}

type EventHandler = (event: DomainEvent) => Promise<void> | void

/**
 * Simple in-memory event bus
 * In production, replace with Kafka/Redpanda
 */
class EventBus {
  private handlers: Map<EventType, Set<EventHandler>> = new Map()
  private fastify: FastifyInstance | null = null

  /**
   * Initialize event bus with Fastify instance
   */
  initialize(fastify: FastifyInstance) {
    this.fastify = fastify
  }

  /**
   * Subscribe to an event type
   */
  subscribe(eventType: EventType, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }

    this.handlers.get(eventType)!.add(handler)

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(eventType)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) {
          this.handlers.delete(eventType)
        }
      }
    }
  }

  /**
   * Publish an event
   */
  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.type)
    
    if (handlers && handlers.size > 0) {
      // Log event
      if (this.fastify) {
        this.fastify.log.info(
          {
            eventType: event.type,
            aggregateId: event.aggregateId,
            aggregateType: event.aggregateType,
          },
          'Event published'
        )
      }

      // Execute all handlers
      const promises = Array.from(handlers).map(async (handler) => {
        try {
          await handler(event)
        } catch (error) {
          if (this.fastify) {
            this.fastify.log.error(
              {
                error,
                eventType: event.type,
                aggregateId: event.aggregateId,
              },
              'Event handler failed'
            )
          }
        }
      })

      await Promise.allSettled(promises)
    }

    // Emit via Socket.io if available
    if (this.fastify?.io) {
      const { emitRealtimeEvent } = require('../plugins/socketio')
      emitRealtimeEvent(this.fastify, event.aggregateType, {
        type: event.type.includes('created') ? 'create' : 
              event.type.includes('updated') ? 'update' : 
              event.type.includes('deleted') ? 'delete' : 'update',
        id: event.aggregateId,
        data: event.data,
      })
    }
  }

  /**
   * Create a domain event
   */
  createEvent(
    type: EventType,
    aggregateId: string,
    aggregateType: string,
    data: any,
    metadata?: Partial<DomainEvent['metadata']>
  ): DomainEvent {
    return {
      type,
      aggregateId,
      aggregateType,
      data,
      metadata: {
        timestamp: Date.now(),
        ...metadata,
      },
    }
  }
}

// Export singleton instance
export const eventBus = new EventBus()

/**
 * Helper to publish lab order events
 */
export function publishLabOrderEvent(
  fastify: FastifyInstance,
  type: 'created' | 'updated' | 'completed',
  orderId: string,
  data: any
) {
  const event = eventBus.createEvent(
    `lab.order.${type}` as EventType,
    orderId,
    'lab-order',
    data,
    {
      userId: (fastify as any).user?.id,
    }
  )
  return eventBus.publish(event)
}

/**
 * Helper to publish lab result events
 */
export function publishLabResultEvent(
  fastify: FastifyInstance,
  type: 'created' | 'updated' | 'finalized',
  resultId: string,
  data: any
) {
  const event = eventBus.createEvent(
    `lab.result.${type}` as EventType,
    resultId,
    'lab-result',
    data,
    {
      userId: (fastify as any).user?.id,
    }
  )
  return eventBus.publish(event)
}

