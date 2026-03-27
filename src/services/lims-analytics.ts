/**
 * LIMS Operational Analytics Service
 * Provides operational metrics for LIMS: test volume, TAT, error rates, productivity
 */

import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { createMetricsCacheHelper } from '../lib/monitoring/cache-metrics'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: any) => void,
) => {
  const cache = createMetricsCacheHelper(fastify, 'lims-analytics')

  // GET /lims-analytics/operational - Get operational metrics
  fastify.get('/lims-analytics/operational', async (request, reply) => {
    try {
      const { startDate, endDate, department } = request.query as any
      
      const cacheKey = `lims-analytics:operational:${startDate || 'all'}:${endDate || 'all'}:${department || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lims_analytics.operational_cache_hit')
        return reply.send(cached)
      }

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const end = endDate ? new Date(endDate) : new Date()

      const analytics: any = {
        period: {
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        },
        testVolume: {},
        turnaroundTime: {},
        errorRates: {},
        productivity: {},
      }

      // Use PostgreSQL if available for better performance
      if (fastify.prisma) {
        try {
          // Test Volume Metrics
          const testVolume = await fastify.prisma.labOrder.groupBy({
            by: ['status'],
            where: {
              orderedAt: {
                gte: start,
                lte: end,
              },
            },
            _count: {
              id: true,
            },
          })

          analytics.testVolume = {
            total: testVolume.reduce((sum: number, item: any) => sum + item._count.id, 0),
            byStatus: testVolume.reduce((acc: any, item: any) => {
              acc[item.status] = item._count.id
              return acc
            }, {}),
          }

          // Completed orders for TAT calculation
          const completedOrders = await fastify.prisma.labOrder.findMany({
            where: {
              status: 'completed',
              finalizedAt: {
                gte: start,
                lte: end,
              },
            },
            select: {
              orderedAt: true,
              finalizedAt: true,
            },
          })

          if (completedOrders.length > 0) {
            const tatValues = completedOrders
              .filter((o: any) => o.finalizedAt && o.orderedAt)
              .map((o: any) => {
                const tat = o.finalizedAt!.getTime() - o.orderedAt.getTime()
                return tat / (1000 * 60 * 60) // Convert to hours
              })

            const avgTAT = tatValues.reduce((sum: number, val: number) => sum + val, 0) / tatValues.length
            const minTAT = Math.min(...tatValues)
            const maxTAT = Math.max(...tatValues)

            analytics.turnaroundTime = {
              average: Math.round(avgTAT * 100) / 100,
              minimum: Math.round(minTAT * 100) / 100,
              maximum: Math.round(maxTAT * 100) / 100,
              median: tatValues.sort((a: number, b: number) => a - b)[Math.floor(tatValues.length / 2)],
              totalCompleted: completedOrders.length,
            }
          }

          // QC Error Rates
          const qcResults = await fastify.prisma.qcResult.findMany({
            where: {
              runAt: {
                gte: start,
                lte: end,
              },
            },
            select: {
              status: true,
            },
          })

          const totalQC = qcResults.length
          const failedQC = qcResults.filter((r: any) => r.status === 'fail').length
          const warningQC = qcResults.filter((r: any) => r.status === 'warning').length

          analytics.errorRates = {
            qcFailureRate: totalQC > 0 ? Math.round((failedQC / totalQC) * 10000) / 100 : 0,
            qcWarningRate: totalQC > 0 ? Math.round((warningQC / totalQC) * 10000) / 100 : 0,
            totalQCTests: totalQC,
            failedQCTests: failedQC,
            warningQCTests: warningQC,
          }

          // Productivity Metrics (results per day)
          const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
          const totalResults = await fastify.prisma.labResult.count({
            where: {
              finalizedAt: {
                gte: start,
                lte: end,
              },
            },
          })

          analytics.productivity = {
            totalResults,
            resultsPerDay: daysDiff > 0 ? Math.round((totalResults / daysDiff) * 100) / 100 : 0,
            periodDays: daysDiff,
          }
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL analytics query failed, using CouchDB fallback')
          // Fallback to CouchDB if PostgreSQL fails
          analytics.error = 'PostgreSQL query failed, using limited metrics'
        }
      } else {
        // Fallback to CouchDB
        const labOrdersDb = fastify.couch?.db.use('lab_orders')
        const qcResultsDb = fastify.couch?.db.use('qc_results')

        if (labOrdersDb) {
          const ordersResult = await labOrdersDb.find({
            selector: {
              type: 'lab_order',
              orderedOn: {
                $gte: start.toISOString(),
                $lte: end.toISOString(),
              },
            },
          })

          analytics.testVolume = {
            total: ordersResult.docs.length,
            byStatus: ordersResult.docs.reduce((acc: any, doc: any) => {
              acc[doc.status] = (acc[doc.status] || 0) + 1
              return acc
            }, {}),
          }
        }

        if (qcResultsDb) {
          const qcResult = await qcResultsDb.find({
            selector: {
              type: 'qc_result',
              runDate: {
                $gte: start.toISOString(),
                $lte: end.toISOString(),
              },
            },
          })

          const totalQC = qcResult.docs.length
          const failedQC = qcResult.docs.filter((d: any) => d.status === 'fail').length

          analytics.errorRates = {
            qcFailureRate: totalQC > 0 ? Math.round((failedQC / totalQC) * 10000) / 100 : 0,
            totalQCTests: totalQC,
            failedQCTests: failedQC,
          }
        }
      }

      // Cache for 15 minutes
      await cache.set(cacheKey, analytics, 900)

      fastify.log.info({ period: analytics.period }, 'lims_analytics.operational')
      reply.send(analytics)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lims_analytics.operational_failed')
      reply.code(500).send({ error: 'Failed to get operational analytics' })
    }
  })

  // GET /lims-analytics/test-volume - Get test volume by test type
  fastify.get('/lims-analytics/test-volume', async (request, reply) => {
    try {
      const { startDate, endDate } = request.query as any
      
      const cacheKey = `lims-analytics:test-volume:${startDate || 'all'}:${endDate || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lims_analytics.test_volume_cache_hit')
        return reply.send(cached)
      }

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const end = endDate ? new Date(endDate) : new Date()

      let testVolume: any = {}

      if (fastify.prisma) {
        try {
          // Get test volume by test code
          const testVolumeData = await fastify.prisma.labOrder.groupBy({
            by: ['testCodeLoinc'],
            where: {
              orderedAt: {
                gte: start,
                lte: end,
              },
              testCodeLoinc: {
                not: null,
              },
            },
            _count: {
              id: true,
            },
            orderBy: {
              _count: {
                id: 'desc',
              },
            },
            take: 20, // Top 20 tests
          })

          // Get test names from catalog
          const testCodes = testVolumeData.map((t: any) => t.testCodeLoinc).filter(Boolean) as string[]
          const testCatalog = await fastify.prisma.testCatalog.findMany({
            where: {
              code: {
                in: testCodes,
              },
            },
            select: {
              code: true,
              name: true,
            },
          })

          const catalogMap = new Map(testCatalog.map((t: any) => [t.code, t.name]))

          testVolume = {
            byTest: testVolumeData.map((item: any) => ({
              testCode: item.testCodeLoinc,
              testName: catalogMap.get(item.testCodeLoinc) || item.testCodeLoinc,
              count: item._count.id,
            })),
            total: testVolumeData.reduce((sum: number, item: any) => sum + item._count.id, 0),
          }
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL test volume query failed')
        }
      }

      // Cache for 15 minutes
      await cache.set(cacheKey, testVolume, 900)

      fastify.log.info({ count: testVolume.byTest?.length || 0 }, 'lims_analytics.test_volume')
      reply.send(testVolume)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lims_analytics.test_volume_failed')
      reply.code(500).send({ error: 'Failed to get test volume analytics' })
    }
  })

  // GET /lims-analytics/dashboard - Get dashboard summary
  fastify.get('/lims-analytics/dashboard', async (_request, reply) => {
    try {
      const cacheKey = 'lims-analytics:dashboard'
      const cached = await cache.get(cacheKey)
      if (cached) {
        fastify.log.debug({ cacheKey }, 'lims_analytics.dashboard_cache_hit')
        return reply.send(cached)
      }

      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

      const dashboard: any = {
        today: {},
        week: {},
        alerts: [],
      }

      if (fastify.prisma) {
        try {
          // Today's metrics
          const todayOrders = await fastify.prisma.labOrder.count({
            where: {
              orderedAt: {
                gte: todayStart,
              },
            },
          })

          const todayCompleted = await fastify.prisma.labOrder.count({
            where: {
              status: 'completed',
              finalizedAt: {
                gte: todayStart,
              },
            },
          })

          const todayPending = await fastify.prisma.labOrder.count({
            where: {
              status: {
                in: ['ordered', 'specimen-collected', 'received', 'in-progress'],
              },
              orderedAt: {
                gte: todayStart,
              },
            },
          })

          // Week's metrics
          const weekOrders = await fastify.prisma.labOrder.count({
            where: {
              orderedAt: {
                gte: weekStart,
              },
            },
          })

          const weekCompleted = await fastify.prisma.labOrder.count({
            where: {
              status: 'completed',
              finalizedAt: {
                gte: weekStart,
              },
            },
          })

          // QC failures today
          const todayQCFailures = await fastify.prisma.qcResult.count({
            where: {
              status: 'fail',
              runAt: {
                gte: todayStart,
              },
            },
          })

          dashboard.today = {
            orders: todayOrders,
            completed: todayCompleted,
            pending: todayPending,
            qcFailures: todayQCFailures,
          }

          dashboard.week = {
            orders: weekOrders,
            completed: weekCompleted,
          }

          // Alerts
          if (todayQCFailures > 0) {
            dashboard.alerts.push({
              type: 'warning',
              message: `${todayQCFailures} QC failure(s) today`,
            })
          }

          if (todayPending > 50) {
            dashboard.alerts.push({
              type: 'info',
              message: `${todayPending} pending orders`,
            })
          }
        } catch (pgError) {
          fastify.log.warn({ error: pgError }, 'PostgreSQL dashboard query failed')
        }
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, dashboard, 300)

      fastify.log.info('lims_analytics.dashboard')
      reply.send(dashboard)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lims_analytics.dashboard_failed')
      reply.code(500).send({ error: 'Failed to get dashboard data' })
    }
  })

  // GET /lims-analytics/financial - Get financial analytics
  fastify.get('/lims-analytics/financial', async (request, reply) => {
    try {
      const { startDate, endDate, testCode, groupBy } = request.query as any
      
      const cacheKey = `lims-analytics:financial:${startDate || 'all'}:${endDate || 'all'}:${testCode || 'all'}:${groupBy || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const revenueDb = fastify.couch?.db.use('revenue_tracking')
      const costDb = fastify.couch?.db.use('cost_accounting')
      const pricingDb = fastify.couch?.db.use('test_pricing')

      if (!revenueDb || !costDb || !pricingDb) {
        reply.code(503).send({ error: 'Financial databases not available' })
        return
      }

      // Get revenue data
      const revenueSelector: any = { type: 'revenueEntry' }
      if (testCode) revenueSelector.testCode = testCode
      if (startDate || endDate) {
        revenueSelector.date = {}
        if (startDate) revenueSelector.date.$gte = startDate
        if (endDate) revenueSelector.date.$lte = endDate
      }

      const revenueResult = await revenueDb.find({ selector: revenueSelector, limit: 10000 })
      const revenues = revenueResult.docs as any[]

      // Get cost data
      const costSelector: any = { type: 'costEntry' }
      if (testCode) costSelector.testCode = testCode
      if (startDate || endDate) {
        costSelector.date = {}
        if (startDate) costSelector.date.$gte = startDate
        if (endDate) costSelector.date.$lte = endDate
      }

      const costResult = await costDb.find({ selector: costSelector, limit: 10000 })
      const costs = costResult.docs as any[]

      // Calculate totals
      const totalRevenue = revenues.reduce((sum: number, doc: any) => sum + (doc.amount || 0), 0)
      const totalCost = costs.reduce((sum: number, doc: any) => sum + (doc.totalCost || 0), 0)
      const profit = totalRevenue - totalCost
      const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0

      // Group by test code if requested
      const byTestCode: Record<string, any> = {}
      if (groupBy === 'testCode' || !groupBy) {
        revenues.forEach((rev: any) => {
          const code = rev.testCode || 'unknown'
          if (!byTestCode[code]) {
            byTestCode[code] = { revenue: 0, cost: 0, count: 0 }
          }
          byTestCode[code].revenue += rev.amount || 0
          byTestCode[code].count += 1
        })

        costs.forEach((cost: any) => {
          const code = cost.testCode || 'unknown'
          if (!byTestCode[code]) {
            byTestCode[code] = { revenue: 0, cost: 0, count: 0 }
          }
          byTestCode[code].cost += cost.totalCost || 0
        })

        // Calculate profit and margin for each test
        Object.keys(byTestCode).forEach((code) => {
          const data = byTestCode[code]
          data.profit = data.revenue - data.cost
          data.margin = data.revenue > 0 ? (data.profit / data.revenue) * 100 : 0
        })
      }

      const response = {
        totalRevenue,
        totalCost,
        profit,
        margin: margin.toFixed(2),
        byTestCode: Object.keys(byTestCode).length > 0 ? byTestCode : undefined,
        period: { startDate, endDate },
      }

      await cache.set(cacheKey, response, 300)
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lims_analytics.financial_failed')
      reply.code(500).send({ error: 'Failed to get financial analytics' })
    }
  })

  // GET /lims-analytics/quality - Get quality analytics
  fastify.get('/lims-analytics/quality', async (request, reply) => {
    try {
      const { startDate, endDate, testCode } = request.query as any
      
      const cacheKey = `lims-analytics:quality:${startDate || 'all'}:${endDate || 'all'}:${testCode || 'all'}`
      const cached = await cache.get(cacheKey)
      if (cached) {
        return reply.send(cached)
      }

      const qcDb = fastify.couch?.db.use('qc_results')
      const resultsDb = fastify.couch?.db.use('lab_results')
      const ordersDb = fastify.couch?.db.use('lab_orders')

      if (!qcDb || !resultsDb || !ordersDb) {
        reply.code(503).send({ error: 'Quality databases not available' })
        return
      }

      // QC Performance
      const qcSelector: any = { type: 'qc_result' }
      if (testCode) qcSelector['testCode.coding.code'] = testCode
      if (startDate || endDate) {
        qcSelector.runDate = {}
        if (startDate) qcSelector.runDate.$gte = startDate
        if (endDate) qcSelector.runDate.$lte = endDate
      }

      const qcResult = await qcDb.find({ selector: qcSelector, limit: 10000 })
      const qcResults = qcResult.docs as any[]
      
      const qcPass = qcResults.filter((r: any) => r.status === 'pass').length
      const qcFail = qcResults.filter((r: any) => r.status === 'fail').length
      const qcWarning = qcResults.filter((r: any) => r.status === 'warning').length
      const qcPassRate = qcResults.length > 0 ? (qcPass / qcResults.length) * 100 : 0

      // Error rates
      const resultsSelector: any = { type: 'lab_result' }
      if (testCode) resultsSelector['testCode.coding.code'] = testCode
      if (startDate || endDate) {
        resultsSelector.reportedDateTime = {}
        if (startDate) resultsSelector.reportedDateTime.$gte = startDate
        if (endDate) resultsSelector.reportedDateTime.$lte = endDate
      }

      const resultsResult = await resultsDb.find({ selector: resultsSelector, limit: 10000 })
      const results = resultsResult.docs as any[]
      
      const resultsWithErrors = results.filter((r: any) => 
        r.flags && (r.flags.includes('critical') || r.flags.includes('abnormal') || r.flags.includes('delta-check-failed'))
      ).length
      const errorRate = results.length > 0 ? (resultsWithErrors / results.length) * 100 : 0

      // TAT (Turnaround Time) - calculate average time from order to result
      const ordersSelector: any = { type: 'lab_order' }
      if (startDate || endDate) {
        ordersSelector.orderedAt = {}
        if (startDate) ordersSelector.orderedAt.$gte = startDate
        if (endDate) ordersSelector.orderedAt.$lte = endDate
      }

      const ordersResult = await ordersDb.find({ selector: ordersSelector, limit: 1000 })
      const orders = ordersResult.docs as any[]
      
      let totalTAT = 0
      let tatCount = 0
      orders.forEach((order: any) => {
        if (order.orderedAt && order.finalizedAt) {
          const tat = new Date(order.finalizedAt).getTime() - new Date(order.orderedAt).getTime()
          totalTAT += tat
          tatCount += 1
        }
      })
      const avgTAT = tatCount > 0 ? totalTAT / tatCount / (1000 * 60 * 60) : 0 // Convert to hours

      // Compliance status (simplified - would check against ISO 15189 requirements)
      const complianceStatus = {
        qcPassRate: qcPassRate >= 95 ? 'compliant' : 'non-compliant',
        errorRate: errorRate <= 5 ? 'compliant' : 'non-compliant',
        avgTAT: avgTAT <= 24 ? 'compliant' : 'non-compliant', // 24 hours target
      }

      const response = {
        qcPerformance: {
          total: qcResults.length,
          pass: qcPass,
          fail: qcFail,
          warning: qcWarning,
          passRate: qcPassRate.toFixed(2),
        },
        errorRate: errorRate.toFixed(2),
        avgTAT: avgTAT.toFixed(2), // hours
        complianceStatus,
        period: { startDate, endDate },
      }

      await cache.set(cacheKey, response, 300)
      reply.send(response)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lims_analytics.quality_failed')
      reply.code(500).send({ error: 'Failed to get quality analytics' })
    }
  })

  next()
}

