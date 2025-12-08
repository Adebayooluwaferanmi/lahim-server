/**
 * LIMS Workflow Service
 * Manages the complete workflow from pre-analytical to post-analytical stages
 * Handles status transitions, workflow automation, and tracking
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus, EventType } from '../lib/event-bus'
import { createCouchDBIndexes } from '../lib/db-utils'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const labOrdersDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('lab_orders')
    : null
  const specimensDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('specimens')
    : null
  const resultsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('lab_results')
    : null
  const reportsDb = fastify.couchAvailable && fastify.couch
    ? fastify.couch.db.use('reports')
    : null
  const cache = createMetricsCacheHelper(fastify, 'workflow')

  // Create indexes
  createCouchDBIndexes(
    fastify,
    'lab_orders',
    [
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId', 'status'] }, name: 'type-patientId-status-index' },
    ],
    'Workflow - Lab Orders'
  )

  // GET /workflow/order/:orderId/timeline - Get complete workflow timeline for an order
  fastify.get('/workflow/order/:orderId/timeline', async (request, reply) => {
    if (!labOrdersDb || !specimensDb || !resultsDb || !reportsDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { orderId } = request.params as { orderId: string }
      const cacheKey = `workflow:timeline:${orderId}`

      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'workflow.timeline_cache_hit')
        return reply.send(cached)
      }

      // Get order
      const order = await labOrdersDb.get(orderId).catch(() => null)
      if (!order || (order as any).type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      // Get specimens for this order
      const specimensResult = await specimensDb.find({
        selector: {
          type: 'specimen',
          orderId,
        },
      })

      // Get results for this order
      const resultsResult = await resultsDb.find({
        selector: {
          type: 'lab_result',
          orderId,
        },
      })

      // Get reports for this order
      const reportsResult = await reportsDb.find({
        selector: {
          type: 'report',
          orderId,
        },
      })

      // Build timeline
      const timeline = []

      // Pre-analytical events
      if ((order as any).orderedAt) {
        timeline.push({
          stage: 'pre-analytical',
          event: 'order_created',
          timestamp: (order as any).orderedAt,
          status: 'requested',
          description: 'Lab order created',
          data: { orderId, patientId: (order as any).patientId },
        })
      }

      if ((order as any).collectedAt) {
        timeline.push({
          stage: 'pre-analytical',
          event: 'specimen_collected',
          timestamp: (order as any).collectedAt,
          status: 'collected',
          description: 'Specimen collected',
          data: { orderId },
        })
      }

      specimensResult.docs.forEach((spec: any) => {
        if (spec.receivedAt) {
          timeline.push({
            stage: 'pre-analytical',
            event: 'specimen_received',
            timestamp: spec.receivedAt,
            status: 'received',
            description: `Specimen received: ${spec.accessionNo || spec._id}`,
            data: { specimenId: spec._id, accessionNo: spec.accessionNo },
          })
        }
        if (spec.processedAt) {
          timeline.push({
            stage: 'pre-analytical',
            event: 'specimen_processed',
            timestamp: spec.processedAt,
            status: 'processed',
            description: `Specimen processed: ${spec.accessionNo || spec._id}`,
            data: { specimenId: spec._id },
          })
        }
      })

      if ((order as any).receivedAt) {
        timeline.push({
          stage: 'pre-analytical',
          event: 'order_received',
          timestamp: (order as any).receivedAt,
          status: 'received',
          description: 'Order received in laboratory',
          data: { orderId },
        })
      }

      // Analytical events
      resultsResult.docs.forEach((result: any) => {
        if (result.createdAt) {
          timeline.push({
            stage: 'analytical',
            event: 'result_entered',
            timestamp: result.createdAt,
            status: result.status || 'preliminary',
            description: `Result entered: ${result.testCode?.coding?.[0]?.code || result.testCode || 'Unknown test'}`,
            data: { resultId: result._id, testCode: result.testCode },
          })
        }
        if (result.finalizedAt || result.reportedDateTime) {
          timeline.push({
            stage: 'analytical',
            event: 'result_finalized',
            timestamp: result.finalizedAt || result.reportedDateTime,
            status: 'finalized',
            description: `Result finalized: ${result.testCode?.coding?.[0]?.code || result.testCode || 'Unknown test'}`,
            data: { resultId: result._id },
          })
        }
      })

      if ((order as any).finalizedAt) {
        timeline.push({
          stage: 'analytical',
          event: 'order_finalized',
          timestamp: (order as any).finalizedAt,
          status: 'completed',
          description: 'All results finalized',
          data: { orderId },
        })
      }

      // Post-analytical events
      reportsResult.docs.forEach((report: any) => {
        if (report.generatedAt || report.createdAt) {
          timeline.push({
            stage: 'post-analytical',
            event: 'report_generated',
            timestamp: report.generatedAt || report.createdAt,
            status: 'generated',
            description: `Report generated: ${report.reportType || 'Standard Report'}`,
            data: { reportId: report._id },
          })
        }
        if (report.deliveredAt) {
          timeline.push({
            stage: 'post-analytical',
            event: 'report_delivered',
            timestamp: report.deliveredAt,
            status: 'delivered',
            description: `Report delivered via ${report.deliveryMethod || 'unknown'}`,
            data: { reportId: report._id, deliveryMethod: report.deliveryMethod },
          })
        }
      })

      // Sort timeline by timestamp
      timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      const response = {
        orderId,
        currentStatus: (order as any).status,
        currentStage: getCurrentStage((order as any).status, timeline),
        timeline,
        summary: {
          preAnalytical: timeline.filter((t) => t.stage === 'pre-analytical').length,
          analytical: timeline.filter((t) => t.stage === 'analytical').length,
          postAnalytical: timeline.filter((t) => t.stage === 'post-analytical').length,
        },
      }

      await cache.set(cacheKey, response, 60) // Cache for 1 minute

      fastify.log.info({ orderId, timelineLength: timeline.length }, 'workflow.timeline')
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'workflow.timeline_failed')
      reply.code(500).send({ error: 'Failed to get workflow timeline' })
    }
  })

  // GET /workflow/dashboard - Get workflow dashboard data
  fastify.get('/workflow/dashboard', async (request, reply) => {
    if (!labOrdersDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const cacheKey = 'workflow:dashboard'
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'workflow.dashboard_cache_hit')
        return reply.send(cached)
      }

      // Get orders by status
      const statuses = ['requested', 'approved', 'collected', 'received', 'in-progress', 'completed']
      const dashboard: any = {
        preAnalytical: {},
        analytical: {},
        postAnalytical: {},
        totals: {},
      }

      for (const status of statuses) {
        const result = await labOrdersDb.find({
          selector: {
            type: 'lab_order',
            status,
          },
          limit: 1000, // Get count
        })

        const count = result.docs.length

        if (['requested', 'approved', 'collected', 'received'].includes(status)) {
          dashboard.preAnalytical[status] = count
        } else if (status === 'in-progress') {
          dashboard.analytical[status] = count
        } else if (status === 'completed') {
          dashboard.postAnalytical[status] = count
        }

        dashboard.totals[status] = count
      }

      // Get pending specimens
      if (specimensDb) {
        const pendingSpecimens = await specimensDb.find({
          selector: {
            type: 'specimen',
            status: { $in: ['collected', 'received', 'processing'] },
          },
          limit: 1000,
        })
        dashboard.preAnalytical.pendingSpecimens = pendingSpecimens.docs.length
      }

      // Get pending results
      if (resultsDb) {
        const pendingResults = await resultsDb.find({
          selector: {
            type: 'lab_result',
            status: { $in: ['preliminary', 'pending'] },
          },
          limit: 1000,
        })
        dashboard.analytical.pendingResults = pendingResults.docs.length
      }

      // Get pending reports
      if (reportsDb) {
        const pendingReports = await reportsDb.find({
          selector: {
            type: 'report',
            status: { $in: ['generated', 'pending'] },
          },
          limit: 1000,
        })
        dashboard.postAnalytical.pendingReports = pendingReports.docs.length
      }

      await cache.set(cacheKey, dashboard, 60) // Cache for 1 minute

      fastify.log.info({}, 'workflow.dashboard')
      reply.send(dashboard)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'workflow.dashboard_failed')
      reply.code(500).send({ error: 'Failed to get workflow dashboard' })
    }
  })

  // POST /workflow/order/:orderId/advance - Advance order to next stage
  fastify.post('/workflow/order/:orderId/advance', async (request, reply) => {
    if (!labOrdersDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { orderId } = request.params as { orderId: string }
      const { targetStatus, performedBy, notes } = request.body as any

      const order = await labOrdersDb.get(orderId) as any
      if (!order || order.type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      const currentStatus = order.status
      const newStatus = targetStatus || getNextStatus(currentStatus)

      if (!newStatus || newStatus === currentStatus) {
        reply.code(400).send({ error: 'Cannot advance to same status or invalid status' })
        return
      }

      // Update order with new status and timestamp
      const updates: any = {
        status: newStatus,
        updatedAt: new Date().toISOString(),
      }

      // Set appropriate timestamp based on status
      if (newStatus === 'collected' && !order.collectedAt) {
        updates.collectedAt = new Date().toISOString()
      } else if (newStatus === 'received' && !order.receivedAt) {
        updates.receivedAt = new Date().toISOString()
      } else if (newStatus === 'completed' && !order.finalizedAt) {
        updates.finalizedAt = new Date().toISOString()
      }

      const updatedOrder = {
        ...order,
        ...updates,
      }

      await labOrdersDb.insert(updatedOrder)

      // Publish workflow event
      await eventBus.publish(
        eventBus.createEvent(
          'lab.order.status.changed' as any,
          orderId,
          'lab-order',
          {
            orderId,
            previousStatus: currentStatus,
            newStatus,
            performedBy,
            notes,
            timestamp: new Date().toISOString(),
          }
        )
      )

      // Invalidate cache
      await cache.deletePattern('workflow:*')
      await cache.deletePattern('lab-orders:*')

      fastify.log.info({ orderId, previousStatus: currentStatus, newStatus }, 'workflow.order_advanced')
      reply.send({ orderId, previousStatus: currentStatus, newStatus, order: updatedOrder })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'workflow.advance_failed')
      reply.code(500).send({ error: 'Failed to advance order' })
    }
  })

  // Helper function to determine current stage
  function getCurrentStage(status: string, timeline: any[]): string {
    if (['requested', 'approved', 'collected', 'received'].includes(status)) {
      return 'pre-analytical'
    } else if (status === 'in-progress') {
      return 'analytical'
    } else if (status === 'completed') {
      return 'post-analytical'
    }
    return 'unknown'
  }

  // Helper function to get next status
  function getNextStatus(currentStatus: string): string | null {
    const statusFlow: Record<string, string> = {
      requested: 'approved',
      approved: 'collected',
      collected: 'received',
      received: 'in-progress',
      'in-progress': 'completed',
    }
    return statusFlow[currentStatus] || null
  }

  // POST /workflow/automate - Automate workflow transitions based on events
  fastify.post('/workflow/automate', async (request, reply) => {
    if (!labOrdersDb) {
      reply.code(503).send({ error: 'CouchDB is not available' })
      return
    }
    try {
      const { orderId, event, data } = request.body as any

      if (!orderId || !event) {
        reply.code(400).send({ error: 'Order ID and event are required' })
        return
      }

      const order = await labOrdersDb.get(orderId).catch(() => null)
      if (!order || (order as any).type !== 'lab_order') {
        reply.code(404).send({ error: 'Lab order not found' })
        return
      }

      let newStatus: string | null = null

      // Automate status transitions based on events
      switch (event) {
        case 'specimen.collected':
          if ((order as any).status === 'approved' || (order as any).status === 'requested') {
            newStatus = 'collected'
          }
          break
        case 'specimen.received':
          if ((order as any).status === 'collected') {
            newStatus = 'received'
          }
          break
        case 'specimen.processed':
          if ((order as any).status === 'received') {
            newStatus = 'in-progress'
          }
          break
        case 'result.finalized':
          // Check if all results are finalized
          if (resultsDb) {
            const pendingResults = await resultsDb.find({
              selector: {
                type: 'lab_result',
                orderId,
                status: { $ne: 'final' },
              },
            })
            if (pendingResults.docs.length === 0) {
              newStatus = 'completed'
            }
          }
          break
        case 'report.generated':
          // Order can be marked as completed if report is generated
          if ((order as any).status === 'in-progress') {
            newStatus = 'completed'
          }
          break
      }

      if (newStatus && newStatus !== (order as any).status) {
        const updates: any = {
          status: newStatus,
          updatedAt: new Date().toISOString(),
        }

        if (newStatus === 'collected' && !(order as any).collectedAt) {
          updates.collectedAt = new Date().toISOString()
        } else if (newStatus === 'received' && !(order as any).receivedAt) {
          updates.receivedAt = new Date().toISOString()
        } else if (newStatus === 'completed' && !(order as any).finalizedAt) {
          updates.finalizedAt = new Date().toISOString()
        }

        const updatedOrder = {
          ...order,
          ...updates,
        }

        await labOrdersDb.insert(updatedOrder)

        // Publish workflow event
        await eventBus.publish(
          eventBus.createEvent(
            'lab.order.status.changed' as any,
            orderId,
            'lab-order',
            {
              orderId,
              previousStatus: (order as any).status,
              newStatus,
              automated: true,
              triggerEvent: event,
              timestamp: new Date().toISOString(),
            }
          )
        )

        // Invalidate cache
        await cache.deletePattern('workflow:*')
        await cache.deletePattern('lab-orders:*')

        fastify.log.info({ orderId, event, previousStatus: (order as any).status, newStatus }, 'workflow.automated')
        reply.send({ orderId, previousStatus: (order as any).status, newStatus, automated: true })
      } else {
        reply.send({ orderId, status: (order as any).status, automated: false, message: 'No status change needed' })
      }
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'workflow.automate_failed')
      reply.code(500).send({ error: 'Failed to automate workflow' })
    }
  })

  next()
}

