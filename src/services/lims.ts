import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
import { eventBus } from '../lib/event-bus'
import { createCouchDBIndexes } from '../lib/db-utils'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  const db = fastify.couch.db.use('lab_results')
  const testCatalogDb = fastify.couch.db.use('test_catalog')

  // Create indexes on service load
  createCouchDBIndexes(
    fastify,
    'lab_results',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'reportedDateTime'] }, name: 'type-reportedDateTime-index' },
      { index: { fields: ['type', 'status', 'reportedDateTime'] }, name: 'type-status-reportedDateTime-index' },
    ],
    'Lab Results'
  )

  // GET /lab-results - List lab results
  fastify.get('/lab-results', async (request, reply) => {
    try {
      const { limit = 50, skip = 0, patientId, testCode, status, startDate, endDate } = request.query as any
      const selector: any = { type: 'lab_result' }

      if (patientId) selector.patientId = patientId
      if (testCode) selector['testCode.coding.code'] = testCode
      if (status) selector.status = status
      if (startDate || endDate) {
        selector.reportedDateTime = {}
        if (startDate) selector.reportedDateTime.$gte = startDate
        if (endDate) selector.reportedDateTime.$lte = endDate
      }

      const result = await db.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ reportedDateTime: 'desc' }],
      })

      fastify.log.info({ count: result.docs.length }, 'lab_results.list')
      reply.send({ results: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_results.list_failed')
      reply.code(500).send({ error: 'Failed to list lab results' })
    }
  })

  // GET /lab-results/:id - Get single lab result
  fastify.get('/lab-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id)

      if ((doc as any).type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      fastify.log.debug({ id }, 'lab_results.get')
      reply.send(doc)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.get_failed')
      reply.code(500).send({ error: 'Failed to get lab result' })
    }
  })

  // POST /lab-results - Create lab result with auto-validation
  fastify.post('/lab-results', async (request, reply) => {
    try {
      const result = request.body as any

      if (!result.patientId || !result.testCode || !result.resultType) {
        reply.code(400).send({ error: 'Patient ID, test code, and result type are required' })
        return
      }

      // Fetch test catalog entry for auto-validation rules
      let validationErrors: string[] = []
      let deltaCheckWarnings: any[] = []
      const testCodeValue = result.testCode?.coding?.[0]?.code || result.testCode
      
      if (testCodeValue) {
        try {
          const catalogResult = await testCatalogDb.find({
            selector: {
              type: 'testCatalogEntry',
              code: testCodeValue,
              active: true,
            },
            limit: 1,
          })

          if (catalogResult.docs.length > 0) {
            const catalogEntry = catalogResult.docs[0] as any
            const validationRules = catalogEntry.analyticalPhases?.analytical?.validationRules
            const deltaCheckRules = catalogEntry.analyticalPhases?.analytical?.deltaCheckRules

            // Auto-validation for numeric results
            if (result.resultType === 'numeric' && result.numericValue !== undefined) {
              if (validationRules?.minValue !== undefined && result.numericValue < validationRules.minValue) {
                validationErrors.push(`Value ${result.numericValue} is below minimum ${validationRules.minValue}`)
              }
              if (validationRules?.maxValue !== undefined && result.numericValue > validationRules.maxValue) {
                validationErrors.push(`Value ${result.numericValue} is above maximum ${validationRules.maxValue}`)
              }
              if (validationRules?.withinReferenceRange && result.referenceRange) {
                const { low, high } = result.referenceRange
                if (low !== undefined && result.numericValue < low) {
                  validationErrors.push(`Value ${result.numericValue} is below reference range (${low}-${high})`)
                }
                if (high !== undefined && result.numericValue > high) {
                  validationErrors.push(`Value ${result.numericValue} is above reference range (${low}-${high})`)
                }
              }

              // Delta check: Compare with previous results
              if (deltaCheckRules?.enabled && result.patientId) {
                try {
                  // Query previous results for the same patient and test code
                  const previousResults = await db.find({
                    selector: {
                      type: 'lab_result',
                      patientId: result.patientId,
                      'testCode.coding.code': testCodeValue,
                      resultType: 'numeric',
                      status: 'final',
                      numericValue: { $exists: true },
                      _id: { $ne: result._id || 'new' }, // Exclude current result if updating
                    },
                    sort: [{ reportedDateTime: 'desc' }],
                    limit: deltaCheckRules.lookbackCount || 5, // Default to last 5 results
                  })

                  if (previousResults.docs.length > 0) {
                    // Get the most recent previous result
                    const previousResult = previousResults.docs[0] as any
                    const previousValue = previousResult.numericValue
                    const currentValue = result.numericValue

                    if (previousValue !== undefined && previousValue !== null && currentValue !== undefined) {
                      // Calculate absolute change
                      const absoluteChange = Math.abs(currentValue - previousValue)
                      
                      // Calculate percentage change
                      const percentageChange = previousValue !== 0 
                        ? Math.abs((currentValue - previousValue) / previousValue) * 100 
                        : currentValue !== 0 ? 100 : 0

                      // Check absolute change threshold
                      if (deltaCheckRules.absoluteChangeThreshold !== undefined && 
                          absoluteChange > deltaCheckRules.absoluteChangeThreshold) {
                        deltaCheckWarnings.push({
                          type: 'absolute_change',
                          previousValue,
                          currentValue,
                          absoluteChange,
                          threshold: deltaCheckRules.absoluteChangeThreshold,
                          message: `Significant absolute change detected: ${absoluteChange.toFixed(2)} (threshold: ${deltaCheckRules.absoluteChangeThreshold})`,
                          previousResultId: previousResult._id,
                          previousReportedDateTime: previousResult.reportedDateTime,
                        })
                      }

                      // Check percentage change threshold
                      if (deltaCheckRules.percentageChangeThreshold !== undefined && 
                          percentageChange > deltaCheckRules.percentageChangeThreshold) {
                        deltaCheckWarnings.push({
                          type: 'percentage_change',
                          previousValue,
                          currentValue,
                          percentageChange: percentageChange.toFixed(2),
                          threshold: deltaCheckRules.percentageChangeThreshold,
                          message: `Significant percentage change detected: ${percentageChange.toFixed(2)}% (threshold: ${deltaCheckRules.percentageChangeThreshold}%)`,
                          previousResultId: previousResult._id,
                          previousReportedDateTime: previousResult.reportedDateTime,
                        })
                      }

                      // If delta check is set to fail on violation, add to validation errors
                      if (deltaCheckRules.failOnViolation && deltaCheckWarnings.length > 0) {
                        deltaCheckWarnings.forEach((warning) => {
                          validationErrors.push(warning.message)
                        })
                      }
                    }
                  }
                } catch (deltaCheckError) {
                  fastify.log.warn({ error: deltaCheckError, testCode: testCodeValue }, 'Failed to perform delta check')
                }
              }
            }
          }
        } catch (catalogError) {
          fastify.log.warn({ error: catalogError, testCode: testCodeValue }, 'Failed to fetch test catalog for validation')
        }
      }

      if (validationErrors.length > 0) {
        reply.code(400).send({ 
          error: 'Validation failed', 
          validationErrors,
          deltaCheckWarnings: deltaCheckWarnings.length > 0 ? deltaCheckWarnings : undefined,
        })
        return
      }

      const now = new Date().toISOString()
      
      // Add flags for delta check failures
      const flags = result.flags || []
      if (deltaCheckWarnings.length > 0) {
        flags.push('delta-check-failed')
      }

      const newResult = {
        ...result,
        type: 'lab_result',
        status: result.status || 'final',
        reportedDateTime: result.reportedDateTime || now,
        flags,
        deltaCheck: deltaCheckWarnings.length > 0 ? {
          warnings: deltaCheckWarnings,
          checkedAt: now,
        } : undefined,
        createdAt: now,
        updatedAt: now,
      }

      const insertResult = await db.insert(newResult)

      // Publish event
      try {
        const eventType = newResult.status === 'final' ? 'lab.result.finalized' : 'lab.result.created'
        await eventBus.publish(
          eventBus.createEvent(
            eventType,
            insertResult.id,
            'lab-result',
            newResult,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab result event')
      }

      // Check for critical values (async, don't block result creation)
      if (result.resultType === 'numeric' && result.numericValue !== undefined) {
        setImmediate(async () => {
          try {
            // Note: Critical value check would be handled by the service itself
            // This is just a placeholder for async notification
            fastify.log.info({ resultId: insertResult.id }, 'critical_value_check_queued')
          } catch (error: unknown) {
            fastify.log.warn({ error, resultId: insertResult.id }, 'Failed to check critical value')
          }
        })
      }

      fastify.log.info({ id: insertResult.id, patientId: result.patientId }, 'lab_results.created')
      reply.code(201).send({ 
        id: insertResult.id, 
        rev: insertResult.rev, 
        ...newResult,
        deltaCheckWarnings: deltaCheckWarnings.length > 0 ? deltaCheckWarnings : undefined,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_results.create_failed')
      reply.code(500).send({ error: 'Failed to create lab result' })
    }
  })

  // PUT /lab-results/:id - Update lab result
  fastify.put('/lab-results/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      }

      const result = await db.insert(updated)

      // Publish event - check if status changed to finalized
      const eventType = updated.status === 'final' && existing.status !== 'final' 
        ? 'lab.result.finalized' 
        : 'lab.result.updated'
      try {
        await eventBus.publish(
          eventBus.createEvent(
            eventType,
            id,
            'lab-result',
            updated,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, `Failed to publish ${eventType} event`)
      }

      fastify.log.info({ id }, 'lab_results.updated')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.update_failed')
      reply.code(500).send({ error: 'Failed to update lab result' })
    }
  })

  // POST /lab-results/:id/review - Pathologist review
  fastify.post('/lab-results/:id/review', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { reviewedBy, reviewNotes, reviewStatus, clinicalSignificance } = request.body as any

      if (!reviewedBy) {
        reply.code(400).send({ error: 'Reviewed by is required' })
        return
      }

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const now = new Date().toISOString()
      const updated = {
        ...existing,
        interpretation: {
          ...existing.interpretation,
          reviewedBy,
          reviewNotes: reviewNotes || existing.interpretation?.reviewNotes,
          reviewStatus: reviewStatus || 'reviewed', // reviewed, pending, approved
          reviewedOn: now,
          clinicalSignificance: clinicalSignificance || existing.interpretation?.clinicalSignificance,
        },
        updatedAt: now,
      }

      const result = await db.insert(updated)

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'lab.result.reviewed',
            id,
            'lab-result',
            updated,
            { userId: reviewedBy }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab result reviewed event')
      }

      fastify.log.info({ id, reviewedBy }, 'lab_results.reviewed')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.review_failed')
      reply.code(500).send({ error: 'Failed to review lab result' })
    }
  })

  // POST /lab-results/:id/addendum - Add addendum
  fastify.post('/lab-results/:id/addendum', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { addendumText, addedBy } = request.body as any

      if (!addendumText || !addedBy) {
        reply.code(400).send({ error: 'Addendum text and added by are required' })
        return
      }

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const now = new Date().toISOString()
      const addendum = {
        text: addendumText,
        addedBy,
        addedOn: now,
      }

      const updated = {
        ...existing,
        interpretation: {
          ...existing.interpretation,
          addendums: [...(existing.interpretation?.addendums || []), addendum],
        },
        updatedAt: now,
      }

      const result = await db.insert(updated)

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'lab.result.addendum',
            id,
            'lab-result',
            updated,
            { userId: addedBy }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab result addendum event')
      }

      fastify.log.info({ id, addedBy }, 'lab_results.addendum_added')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.addendum_failed')
      reply.code(500).send({ error: 'Failed to add addendum' })
    }
  })

  // POST /lab-results/:id/correlation - Add clinical correlation
  fastify.post('/lab-results/:id/correlation', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { correlationText, correlatedBy, relatedResults } = request.body as any

      if (!correlationText || !correlatedBy) {
        reply.code(400).send({ error: 'Correlation text and correlated by are required' })
        return
      }

      const existing = await db.get(id) as any

      if (existing.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const now = new Date().toISOString()
      const correlation = {
        text: correlationText,
        correlatedBy,
        correlatedOn: now,
        relatedResults: relatedResults || [],
      }

      const updated = {
        ...existing,
        interpretation: {
          ...existing.interpretation,
          clinicalCorrelations: [...(existing.interpretation?.clinicalCorrelations || []), correlation],
        },
        updatedAt: now,
      }

      const result = await db.insert(updated)

      // Publish event
      try {
        await eventBus.publish(
          eventBus.createEvent(
            'lab.result.correlation',
            id,
            'lab-result',
            updated,
            { userId: correlatedBy }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish lab result correlation event')
      }

      fastify.log.info({ id, correlatedBy }, 'lab_results.correlation_added')
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.correlation_failed')
      reply.code(500).send({ error: 'Failed to add clinical correlation' })
    }
  })

  // GET /lab-results/:id/interpretation - Get interpretation data
  fastify.get('/lab-results/:id/interpretation', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await db.get(id) as any

      if (doc.type !== 'lab_result') {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }

      const interpretation = doc.interpretation || {}

      fastify.log.debug({ id }, 'lab_results.interpretation_retrieved')
      reply.send(interpretation)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Lab result not found' })
        return
      }
      fastify.log.error({ error: error as Error, id: (request.params as any).id }, 'lab_results.interpretation_failed')
      reply.code(500).send({ error: 'Failed to get interpretation' })
    }
  })

  // GET /lab-results/previous - Get previous results for delta check comparison
  fastify.get('/lab-results/previous', async (request, reply) => {
    try {
      const { patientId, testCode, limit = 5, excludeId } = request.query as any

      if (!patientId || !testCode) {
        reply.code(400).send({ error: 'Patient ID and test code are required' })
        return
      }

      const testCodeValue = typeof testCode === 'string' ? testCode : (testCode as any)?.coding?.[0]?.code || testCode

      const selector: any = {
        type: 'lab_result',
        patientId,
        'testCode.coding.code': testCodeValue,
        resultType: 'numeric',
        status: 'final',
        numericValue: { $exists: true },
      }

      if (excludeId) {
        selector._id = { $ne: excludeId }
      }

      const result = await db.find({
        selector,
        sort: [{ reportedDateTime: 'desc' }],
        limit: parseInt(limit, 10),
      })

      fastify.log.debug({ patientId, testCode: testCodeValue, count: result.docs.length }, 'lab_results.previous_retrieved')
      reply.send({ previousResults: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'lab_results.previous_failed')
      reply.code(500).send({ error: 'Failed to get previous results' })
    }
  })

  next()
}

