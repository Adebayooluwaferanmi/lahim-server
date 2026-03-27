import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // Ensure databases exist
  if (fastify.couchAvailable && fastify.couch) {
    await ensureCouchDBDatabase(fastify, 'invoices')
    await ensureCouchDBDatabase(fastify, 'charges')
    await ensureCouchDBDatabase(fastify, 'payments')
  }

  // Only create database references if CouchDB is available
  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Billing service: CouchDB not available - endpoints will return errors')
    return
  }

  const invoicesDb = fastify.couch.db.use('invoices')
  const chargesDb = fastify.couch.db.use('charges')
  const paymentsDb = fastify.couch.db.use('payments')

  // Create indexes for sorted queries
  createCouchDBIndexes(
    fastify,
    'charges',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'date'] }, name: 'type-date-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'visitId'] }, name: 'type-visitId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['date'] }, name: 'date-index' },
    ],
    'Billing (charges)'
  )
  createCouchDBIndexes(
    fastify,
    'invoices',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'billDate'] }, name: 'type-billDate-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['billDate'] }, name: 'billDate-index' },
    ],
    'Billing (invoices)'
  )
  createCouchDBIndexes(
    fastify,
    'payments',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'paymentDate'] }, name: 'type-paymentDate-index' },
      { index: { fields: ['type', 'invoiceId'] }, name: 'type-invoiceId-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['paymentDate'] }, name: 'paymentDate-index' },
    ],
    'Billing (payments)'
  )
  // const paymentProfilesDb = fastify.couch.db.use('payment_profiles') // Reserved for future use

  // ========== CHARGES ==========

  // GET /charges - List charges
  fastify.get('/charges', async (request, reply) => {
    try {
      const { patientId, visitId, status, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'charge' }

      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (status) selector.status = status

      const result = await chargesDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ date: 'desc' }],
      })

      reply.send({ charges: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'charges.list_failed')
      reply.code(500).send({ error: 'Failed to list charges' })
    }
  })

  // POST /charges - Create charge
  fastify.post('/charges', async (request, reply) => {
    try {
      const charge = request.body as any

      if (!charge.patientId || !charge.description || !charge.quantity || charge.unitPrice === undefined) {
        reply.code(400).send({ error: 'Patient ID, description, quantity, and unit price are required' })
        return
      }

      const now = new Date().toISOString()
      const totalAmount = (charge.quantity || 0) * (charge.unitPrice || 0)
      const newCharge = {
        ...charge,
        type: 'charge',
        totalAmount,
        status: charge.status || 'pending',
        date: charge.date || now,
        createdAt: now,
        updatedAt: now,
      }

      const result = await chargesDb.insert(newCharge)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'charge.created',
            result.id,
            'charge',
            newCharge,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish charge created event')
      }

      reply.code(201).send({ id: result.id, rev: result.rev, ...newCharge })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'charges.create_failed')
      reply.code(500).send({ error: 'Failed to create charge' })
    }
  })

  // ========== INVOICES ==========

  // GET /invoices - List invoices
  fastify.get('/invoices', async (request, reply) => {
    try {
      const { patientId, visitId, status, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'invoice', archived: { $ne: true } }

      if (patientId) selector.patientId = patientId
      if (visitId) selector.visitId = visitId
      if (status) selector.status = status

      const result = await invoicesDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ billDate: 'desc' }],
      })

      reply.send({ invoices: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'invoices.list_failed')
      reply.code(500).send({ error: 'Failed to list invoices' })
    }
  })

  // GET /invoices/:id - Get single invoice
  fastify.get('/invoices/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await invoicesDb.get(id)

      if ((doc as any).type !== 'invoice') {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }

      // Fetch related charges and payments
      const invoice = doc as any
      if (invoice.lineItems && invoice.lineItems.length > 0) {
        try {
          const charges = await Promise.all(
            invoice.lineItems.map((chargeId: string) => chargesDb.get(chargeId).catch(() => null))
          )
          invoice.charges = charges.filter((c) => c !== null)
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to fetch charges for invoice')
        }
      }

      if (invoice.payments && invoice.payments.length > 0) {
        try {
          const payments = await Promise.all(
            invoice.payments.map((paymentId: string) => paymentsDb.get(paymentId).catch(() => null))
          )
          invoice.paymentHistory = payments.filter((p) => p !== null)
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to fetch payments for invoice')
        }
      }

      reply.send(invoice)
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }
      fastify.log.error(error as Error, 'invoices.get_failed')
      reply.code(500).send({ error: 'Failed to get invoice' })
    }
  })

  // POST /invoices - Create invoice
  fastify.post('/invoices', async (request, reply) => {
    try {
      const invoice = request.body as any

      if (!invoice.patientId || !invoice.billDate) {
        reply.code(400).send({ error: 'Patient ID and bill date are required' })
        return
      }

      const now = new Date().toISOString()
      
      // Calculate totals from line items if provided
      let subtotal = invoice.subtotal || 0
      let total = subtotal
      
      if (invoice.lineItems && invoice.lineItems.length > 0) {
        try {
          const charges = await Promise.all(
            invoice.lineItems.map((chargeId: string) => chargesDb.get(chargeId).catch(() => null))
          )
          const validCharges = charges.filter((c) => c !== null)
          subtotal = validCharges.reduce((sum, charge: any) => sum + (charge.totalAmount || 0), 0)
          total = subtotal + (invoice.tax || 0) - (invoice.discount || 0)
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to calculate invoice totals from charges')
        }
      }

      const newInvoice = {
        ...invoice,
        type: 'invoice',
        status: invoice.status || 'Draft',
        subtotal,
        total,
        tax: invoice.tax || 0,
        discount: invoice.discount || 0,
        paidTotal: 0,
        balance: total,
        lineItems: invoice.lineItems || [],
        payments: invoice.payments || [],
        archived: false,
        createdAt: now,
        updatedAt: now,
        lastModified: now,
      }

      const result = await invoicesDb.insert(newInvoice)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'invoice.created',
            result.id,
            'invoice',
            newInvoice,
            { userId: (fastify as any).user?.id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish invoice created event')
      }

      reply.code(201).send({ id: result.id, rev: result.rev, ...newInvoice })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'invoices.create_failed')
      reply.code(500).send({ error: 'Failed to create invoice' })
    }
  })

  // PUT /invoices/:id - Update invoice
  fastify.put('/invoices/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updates = request.body as any

      const existing = await invoicesDb.get(id)
      if ((existing as any).type !== 'invoice') {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }

      const now = new Date().toISOString()
      const updated = {
        ...existing,
        ...updates,
        _id: id,
        _rev: (existing as any)._rev,
        updatedAt: now,
        lastModified: now,
      }

      // Recalculate balance if payments changed
      if (updates.payments) {
        try {
          const payments = await Promise.all(
            updated.payments.map((paymentId: string) => paymentsDb.get(paymentId).catch(() => null))
          )
          const validPayments = payments.filter((p) => p !== null)
          updated.paidTotal = validPayments.reduce((sum, payment: any) => sum + (payment.amount || 0), 0)
          updated.balance = updated.total - updated.paidTotal
          updated.status = updated.balance <= 0 ? 'Paid' : updated.paidTotal > 0 ? 'PartiallyPaid' : updated.status
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to recalculate invoice balance')
        }
      }

      const result = await invoicesDb.insert(updated)
      reply.send({ id: result.id, rev: result.rev, ...updated })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }
      fastify.log.error(error as Error, 'invoices.update_failed')
      reply.code(500).send({ error: 'Failed to update invoice' })
    }
  })

  // POST /invoices/:id/payments - Add payment to invoice
  fastify.post('/invoices/:id/payments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const paymentData = request.body as any

      if (!paymentData.amount || !paymentData.paymentDate) {
        reply.code(400).send({ error: 'Amount and payment date are required' })
        return
      }

      // Get invoice
      const invoice = await invoicesDb.get(id)
      if ((invoice as any).type !== 'invoice') {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }

      // Create payment
      const now = new Date().toISOString()
      const newPayment = {
        ...paymentData,
        type: 'payment',
        invoiceId: id,
        patientId: (invoice as any).patientId,
        createdAt: now,
        updatedAt: now,
      }

      const paymentResult = await paymentsDb.insert(newPayment)

      // Update invoice
      const invoicePayments = (invoice as any).payments || []
      invoicePayments.push(paymentResult.id)

      const paidTotal = ((invoice as any).paidTotal || 0) + paymentData.amount
      const balance = (invoice as any).total - paidTotal
      let status = (invoice as any).status
      if (balance <= 0) {
        status = 'Paid'
      } else if (paidTotal > 0) {
        status = 'PartiallyPaid'
      }

      const updatedInvoice = {
        ...invoice,
        _id: id,
        _rev: (invoice as any)._rev,
        payments: invoicePayments,
        paidTotal,
        balance,
        status,
        updatedAt: now,
        lastModified: now,
      }

      await invoicesDb.insert(updatedInvoice)

      // Publish event
      try {
        const { eventBus } = require('../lib/event-bus')
        await eventBus.publish(
          eventBus.createEvent(
            'payment.created',
            paymentResult.id,
            'payment',
            newPayment,
            { userId: (fastify as any).user?.id, invoiceId: id }
          )
        )
      } catch (eventError) {
        fastify.log.warn({ error: eventError }, 'Failed to publish payment created event')
      }

      reply.code(201).send({ id: paymentResult.id, rev: paymentResult.rev, ...newPayment })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }
      fastify.log.error(error as Error, 'payments.create_failed')
      reply.code(500).send({ error: 'Failed to add payment' })
    }
  })

  // GET /payments - List payments
  fastify.get('/payments', async (request, reply) => {
    try {
      const { invoiceId, patientId, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'payment' }

      if (invoiceId) selector.invoiceId = invoiceId
      if (patientId) selector.patientId = patientId

      const result = await paymentsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
        sort: [{ paymentDate: 'desc' }],
      })

      reply.send({ payments: result.docs, count: result.docs.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'payments.list_failed')
      reply.code(500).send({ error: 'Failed to list payments' })
    }
  })

}

