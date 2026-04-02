import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { ensureCouchDBDatabase, createCouchDBIndexes } from '../lib/db-utils'
import { emitRealtimeEvent } from '../plugins/socketio'

const toNumber = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const isoNow = () => new Date().toISOString()

  const sortByDateDesc = (docs: any[], field: string) =>
  [...docs].sort((left, right) => String(right[field] || '').localeCompare(String(left[field] || '')))

const isOverrideActive = (override: any, currentTimestamp: string) => {
  if (override?.active === false) return false
  if (override?.status === 'revoked') return false
  if (!override?.expiresAt) return true
  return String(override.expiresAt) >= currentTimestamp
}

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  const writeUnavailable = async (_request: any, reply: any) => {
    reply.code(503).send({ error: 'CouchDB not available' })
  }

  if (fastify.couchAvailable && fastify.couch) {
    for (const dbName of [
      'charges',
      'invoices',
      'payments',
      'patient_financial_accounts',
      'patient_wallets',
      'financial_transactions',
      'billing_overrides',
    ]) {
      await ensureCouchDBDatabase(fastify, dbName)
    }
  }

  if (!fastify.couchAvailable || !fastify.couch) {
    fastify.log.warn('Patient finance service: CouchDB not available - registering stub endpoints')

    fastify.get('/financial/summary', async (_request, reply) => {
      reply.send({
        totals: {
          billed: 0,
          collected: 0,
          outstanding: 0,
          walletBalance: 0,
          activeOverrideAmount: 0,
        },
        counts: {
          invoices: 0,
          payments: 0,
          wallets: 0,
          activeOverrides: 0,
          patientsWithOutstanding: 0,
        },
        generatedAt: isoNow(),
      })
    })

    fastify.get('/financial/accounts/:patientId/summary', async (_request, reply) => {
      reply.code(503).send({ error: 'CouchDB not available' })
    })

    fastify.post('/financial/accounts', writeUnavailable)
    fastify.get('/financial/wallets/:patientId', async (request, reply) => {
      const { patientId } = request.params as { patientId: string }
      reply.send({ patientId, balance: 0, currency: 'NGN', status: 'inactive' })
    })
    fastify.post('/financial/wallets/:patientId/fund', writeUnavailable)
    fastify.post('/financial/invoices/:id/settle-from-wallet', writeUnavailable)
    fastify.get('/financial/transactions', async (_request, reply) => {
      reply.send({ transactions: [], count: 0 })
    })
    fastify.get('/financial/overrides', async (_request, reply) => {
      reply.send({ overrides: [], count: 0 })
    })
    fastify.post('/financial/overrides', writeUnavailable)
    fastify.post('/financial/overrides/:id/revoke', writeUnavailable)
    return
  }

  const accountsDb = fastify.couch.db.use('patient_financial_accounts')
  const walletsDb = fastify.couch.db.use('patient_wallets')
  const transactionsDb = fastify.couch.db.use('financial_transactions')
  const overridesDb = fastify.couch.db.use('billing_overrides')
  const invoicesDb = fastify.couch.db.use('invoices')
  const chargesDb = fastify.couch.db.use('charges')
  const paymentsDb = fastify.couch.db.use('payments')

  await createCouchDBIndexes(
    fastify,
    'patient_financial_accounts',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Patient finance accounts',
  )

  await createCouchDBIndexes(
    fastify,
    'patient_wallets',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Patient finance wallets',
  )

  await createCouchDBIndexes(
    fastify,
    'financial_transactions',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
      { index: { fields: ['type', 'transactionType'] }, name: 'type-transactionType-index' },
      { index: { fields: ['type', 'invoiceId'] }, name: 'type-invoiceId-index' },
      { index: { fields: ['type', 'postedAt'] }, name: 'type-postedAt-index' },
    ],
    'Patient finance transactions',
  )

  await createCouchDBIndexes(
    fastify,
    'billing_overrides',
    [
      { index: { fields: ['type'] }, name: 'type-index' },
      { index: { fields: ['type', 'patientId'] }, name: 'type-patientId-index' },
      { index: { fields: ['type', 'active'] }, name: 'type-active-index' },
      { index: { fields: ['type', 'status'] }, name: 'type-status-index' },
    ],
    'Patient finance overrides',
  )

  const listDocs = async (db: any, selector: any, limit = 1000) => {
    const result = await db.find({ selector, limit })
    return result.docs as any[]
  }

  const getSingleDoc = async (db: any, selector: any) => {
    const docs = await listDocs(db, selector, 1)
    return docs[0] || null
  }

  const getPatientAccount = (patientId: string) =>
    getSingleDoc(accountsDb, { type: 'patientFinancialAccount', patientId })

  const getPatientWallet = (patientId: string) =>
    getSingleDoc(walletsDb, { type: 'patientWallet', patientId })

  const getPatientOverrides = async (patientId: string) => {
    const currentTimestamp = isoNow()
    const docs = await listDocs(overridesDb, { type: 'billingOverride', patientId })
    return sortByDateDesc(
      docs.filter((override) => isOverrideActive(override, currentTimestamp)),
      'grantedAt',
    )
  }

  const emitFinancialUpdate = (patientId: string, event: string, payload: Record<string, unknown>) => {
    if (!(fastify as any).io) return

    const eventPayload = {
      event,
      patientId,
      timestamp: isoNow(),
      ...payload,
    }

    emitRealtimeEvent(fastify, `patient-finance:${patientId}`, {
      type: 'update',
      id: patientId,
      data: eventPayload,
    })

    emitRealtimeEvent(fastify, 'financial-summary', {
      type: 'update',
      id: patientId,
      data: eventPayload,
    })

    if (event.startsWith('override.')) {
      emitRealtimeEvent(fastify, 'billing-overrides', {
        type: 'update',
        id: String(payload.overrideId || patientId),
        data: eventPayload,
      })
    }
  }

  const ensureAccountAndWallet = async (payload: any) => {
    const patientId = String(payload.patientId || '')
    const timestamp = isoNow()

    let account = await getPatientAccount(patientId)
    if (!account) {
      const accountDoc = {
        type: 'patientFinancialAccount',
        patientId,
        currency: payload.currency || 'NGN',
        status: payload.status || 'active',
        selfPay: payload.selfPay !== undefined ? Boolean(payload.selfPay) : true,
        creditLimit: toNumber(payload.creditLimit),
        notes: payload.notes || '',
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const result = await accountsDb.insert(accountDoc as any)
      account = {
        _id: result.id,
        _rev: result.rev,
        ...accountDoc,
      }
    }

    let wallet = await getPatientWallet(patientId)
    if (!wallet) {
      const walletDoc = {
        type: 'patientWallet',
        patientId,
        currency: account.currency || payload.currency || 'NGN',
        status: 'active',
        balance: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const result = await walletsDb.insert(walletDoc as any)
      wallet = {
        _id: result.id,
        _rev: result.rev,
        ...walletDoc,
      }
    }

    return { account, wallet }
  }

  const buildPatientSummary = async (patientId: string) => {
    const currentTimestamp = isoNow()
    const [account, wallet, overrides, invoices, charges, payments, transactions] = await Promise.all([
      getPatientAccount(patientId),
      getPatientWallet(patientId),
      getPatientOverrides(patientId),
      listDocs(invoicesDb, { type: 'invoice', patientId, archived: { $ne: true } }),
      listDocs(chargesDb, { type: 'charge', patientId, status: { $ne: 'cancelled' } }),
      listDocs(paymentsDb, { type: 'payment', patientId }),
      listDocs(transactionsDb, { type: 'financialTransaction', patientId }, 20),
    ])

    const activeOverrides = overrides.filter((override) => isOverrideActive(override, currentTimestamp))
    const totalBilled = invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
    const totalPaid = payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0)
    const outstandingBalance = invoices.reduce((sum, invoice) => sum + Math.max(toNumber(invoice.balance), 0), 0)
    const pendingChargesAmount = charges
      .filter((charge) => String(charge.status || '') === 'pending')
      .reduce((sum, charge) => sum + toNumber(charge.totalAmount), 0)
    const walletBalance = toNumber(wallet?.balance)
    const overrideApprovedAmount = activeOverrides.reduce(
      (sum, override) => sum + toNumber(override.approvedAmount ?? override.limitAmount),
      0,
    )
    const requiredClearanceAmount = outstandingBalance + pendingChargesAmount

    let clearanceStatus = 'payment-required'
    let clearanceReason = 'Patient has outstanding balance that must be settled before service update'

    if (requiredClearanceAmount <= 0) {
      clearanceStatus = 'cleared'
      clearanceReason = 'No outstanding financial obligation blocks service progression'
    } else if (activeOverrides.length > 0) {
      clearanceStatus = 'override'
      clearanceReason = 'Billing override is active for this patient'
    } else if (walletBalance >= requiredClearanceAmount) {
      clearanceStatus = 'wallet-available'
      clearanceReason = 'Wallet balance can settle the current financial obligation'
    }

    return {
      patientId,
      account,
      wallet: wallet || {
        patientId,
        balance: 0,
        currency: account?.currency || 'NGN',
        status: 'inactive',
      },
      activeOverrides,
      recentTransactions: sortByDateDesc(transactions, 'postedAt').slice(0, 10),
      counts: {
        invoices: invoices.length,
        charges: charges.length,
        payments: payments.length,
        overrides: activeOverrides.length,
      },
      totals: {
        billed: totalBilled,
        paid: totalPaid,
        outstanding: outstandingBalance,
        pendingCharges: pendingChargesAmount,
        walletBalance,
        approvedOverrideAmount: overrideApprovedAmount,
        availableCoverage: walletBalance + overrideApprovedAmount,
      },
      serviceClearance: {
        status: clearanceStatus,
        canProceed: clearanceStatus !== 'payment-required',
        reason: clearanceReason,
        requiredAmount: requiredClearanceAmount,
      },
      generatedAt: currentTimestamp,
    }
  }

  fastify.get('/financial/summary', async (request, reply) => {
    try {
      const { patientId } = request.query as { patientId?: string }

      if (patientId) {
        reply.send(await buildPatientSummary(patientId))
        return
      }

      const [invoices, payments, wallets, overrides] = await Promise.all([
        listDocs(invoicesDb, { type: 'invoice', archived: { $ne: true } }),
        listDocs(paymentsDb, { type: 'payment' }),
        listDocs(walletsDb, { type: 'patientWallet' }),
        listDocs(overridesDb, { type: 'billingOverride', active: true }),
      ])

      const patientsWithOutstanding = new Set(
        invoices.filter((invoice) => toNumber(invoice.balance) > 0).map((invoice) => String(invoice.patientId || '')),
      )

      reply.send({
        totals: {
          billed: invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0),
          collected: payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0),
          outstanding: invoices.reduce((sum, invoice) => sum + Math.max(toNumber(invoice.balance), 0), 0),
          walletBalance: wallets.reduce((sum, walletDoc) => sum + toNumber(walletDoc.balance), 0),
          activeOverrideAmount: overrides.reduce(
            (sum, override) => sum + toNumber(override.approvedAmount ?? override.limitAmount),
            0,
          ),
        },
        counts: {
          invoices: invoices.length,
          payments: payments.length,
          wallets: wallets.length,
          activeOverrides: overrides.length,
          patientsWithOutstanding: patientsWithOutstanding.size,
        },
        generatedAt: isoNow(),
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.summary_failed')
      reply.code(500).send({ error: 'Failed to compute financial summary' })
    }
  })

  fastify.post('/financial/accounts', async (request, reply) => {
    try {
      const payload = request.body as any
      if (!payload?.patientId) {
        reply.code(400).send({ error: 'Patient ID is required' })
        return
      }

      const { account, wallet } = await ensureAccountAndWallet(payload)
      emitFinancialUpdate(String(payload.patientId), 'account.created', {
        accountId: account._id,
        walletId: wallet._id,
      })

      reply.code(201).send({ account, wallet })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.accounts.create_failed')
      reply.code(500).send({ error: 'Failed to create patient financial account' })
    }
  })

  fastify.get('/financial/accounts/:patientId/summary', async (request, reply) => {
    try {
      const { patientId } = request.params as { patientId: string }
      reply.send(await buildPatientSummary(patientId))
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.accounts.summary_failed')
      reply.code(500).send({ error: 'Failed to get patient financial summary' })
    }
  })

  fastify.get('/financial/wallets/:patientId', async (request, reply) => {
    try {
      const { patientId } = request.params as { patientId: string }
      const wallet = await getPatientWallet(patientId)
      const account = await getPatientAccount(patientId)

      reply.send(
        wallet || {
          patientId,
          currency: account?.currency || 'NGN',
          status: 'inactive',
          balance: 0,
        },
      )
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.wallets.get_failed')
      reply.code(500).send({ error: 'Failed to get patient wallet' })
    }
  })

  fastify.post('/financial/wallets/:patientId/fund', async (request, reply) => {
    try {
      const { patientId } = request.params as { patientId: string }
      const payload = request.body as any
      const amount = toNumber(payload?.amount)

      if (amount <= 0) {
        reply.code(400).send({ error: 'Funding amount must be greater than zero' })
        return
      }

      const { account, wallet } = await ensureAccountAndWallet({ patientId, currency: payload?.currency })
      const timestamp = isoNow()
      const updatedWallet = {
        ...wallet,
        balance: toNumber(wallet.balance) + amount,
        updatedAt: timestamp,
        lastFundedAt: timestamp,
      }

      const walletResult = await walletsDb.insert(updatedWallet)
      const transactionDoc = {
        type: 'financialTransaction',
        patientId,
        walletId: wallet._id,
        direction: 'credit',
        transactionType: 'walletFunding',
        status: 'completed',
        currency: account.currency || payload?.currency || 'NGN',
        amount,
        paymentMethod: payload?.paymentMethod || payload?.channel || 'bank_transfer',
        channel: payload?.channel || payload?.paymentMethod || 'bank_transfer',
        referenceNumber: payload?.referenceNumber,
        receivedBy: payload?.receivedBy,
        notes: payload?.notes,
        postedAt: payload?.postedAt || timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const transactionResult = await transactionsDb.insert(transactionDoc as any)
      emitFinancialUpdate(patientId, 'wallet.funded', {
        walletBalance: updatedWallet.balance,
        amount,
      })

      reply.code(201).send({
        wallet: {
          ...updatedWallet,
          _rev: walletResult.rev,
        },
        transaction: {
          _id: transactionResult.id,
          _rev: transactionResult.rev,
          ...transactionDoc,
        },
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.wallets.fund_failed')
      reply.code(500).send({ error: 'Failed to fund patient wallet' })
    }
  })

  fastify.post('/financial/invoices/:id/settle-from-wallet', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const payload = request.body as any
      const invoice = await invoicesDb.get(id)

      if ((invoice as any).type !== 'invoice') {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }

      const patientId = String((invoice as any).patientId || '')
      const wallet = await getPatientWallet(patientId)
      if (!wallet) {
        reply.code(404).send({ error: 'Patient wallet not found' })
        return
      }

      const invoiceBalance = Math.max(toNumber((invoice as any).balance), 0)
      if (invoiceBalance <= 0) {
        reply.code(409).send({ error: 'Invoice is already fully settled' })
        return
      }

      const requestedAmount = toNumber(payload?.amount) || invoiceBalance
      const settlementAmount = Math.min(requestedAmount, invoiceBalance)

      if (settlementAmount <= 0) {
        reply.code(400).send({ error: 'Settlement amount must be greater than zero' })
        return
      }

      if (toNumber(wallet.balance) < settlementAmount) {
        reply.code(409).send({ error: 'Insufficient wallet balance' })
        return
      }

      const timestamp = isoNow()
      const paymentDoc = {
        type: 'payment',
        invoiceId: id,
        patientId,
        amount: settlementAmount,
        paymentDate: payload?.paymentDate || timestamp,
        paymentMethod: 'wallet',
        referenceNumber: payload?.referenceNumber,
        receivedBy: payload?.receivedBy,
        notes: payload?.notes,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const paymentResult = await paymentsDb.insert(paymentDoc as any)
      const invoicePayments = Array.isArray((invoice as any).payments) ? [...(invoice as any).payments] : []
      invoicePayments.push(paymentResult.id)

      const paidTotal = toNumber((invoice as any).paidTotal) + settlementAmount
      const balance = Math.max(toNumber((invoice as any).total) - paidTotal, 0)
      const status = balance <= 0 ? 'Paid' : paidTotal > 0 ? 'PartiallyPaid' : (invoice as any).status

      const updatedInvoice = {
        ...invoice,
        payments: invoicePayments,
        paidTotal,
        balance,
        status,
        updatedAt: timestamp,
        lastModified: timestamp,
      }

      const updatedWallet = {
        ...wallet,
        balance: toNumber(wallet.balance) - settlementAmount,
        updatedAt: timestamp,
        lastSettledAt: timestamp,
      }

      const transactionDoc = {
        type: 'financialTransaction',
        patientId,
        walletId: wallet._id,
        invoiceId: id,
        direction: 'debit',
        transactionType: 'walletSettlement',
        status: 'completed',
        currency: wallet.currency || 'NGN',
        amount: settlementAmount,
        paymentMethod: 'wallet',
        channel: 'wallet',
        referenceNumber: payload?.referenceNumber,
        notes: payload?.notes,
        postedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const [invoiceResult, walletResult, transactionResult] = await Promise.all([
        invoicesDb.insert(updatedInvoice),
        walletsDb.insert(updatedWallet),
        transactionsDb.insert(transactionDoc as any),
      ])

      emitFinancialUpdate(patientId, 'invoice.settled_from_wallet', {
        invoiceId: id,
        amount: settlementAmount,
        remainingBalance: balance,
        walletBalance: updatedWallet.balance,
      })

      reply.code(201).send({
        invoice: {
          ...updatedInvoice,
          _rev: invoiceResult.rev,
        },
        wallet: {
          ...updatedWallet,
          _rev: walletResult.rev,
        },
        payment: {
          _id: paymentResult.id,
          _rev: paymentResult.rev,
          ...paymentDoc,
        },
        transaction: {
          _id: transactionResult.id,
          _rev: transactionResult.rev,
          ...transactionDoc,
        },
      })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Invoice not found' })
        return
      }
      fastify.log.error(error as Error, 'patient_finance.wallet_settlement_failed')
      reply.code(500).send({ error: 'Failed to settle invoice from wallet' })
    }
  })

  fastify.get('/financial/transactions', async (request, reply) => {
    try {
      const { patientId, status, transactionType, limit = 50, skip = 0 } = request.query as any
      const selector: any = { type: 'financialTransaction' }

      if (patientId) selector.patientId = patientId
      if (status) selector.status = status
      if (transactionType) selector.transactionType = transactionType

      const result = await transactionsDb.find({
        selector,
        limit: parseInt(limit, 10),
        skip: parseInt(skip, 10),
      })

      reply.send({
        transactions: sortByDateDesc(result.docs as any[], 'postedAt'),
        count: result.docs.length,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.transactions.list_failed')
      reply.code(500).send({ error: 'Failed to list financial transactions' })
    }
  })

  fastify.get('/financial/overrides', async (request, reply) => {
    try {
      const { patientId, active = 'true' } = request.query as any
      const selector: any = { type: 'billingOverride' }
      if (patientId) selector.patientId = patientId
      if (active !== undefined) selector.active = active === 'true'

      const overrides = sortByDateDesc(await listDocs(overridesDb, selector), 'grantedAt')
      const patientIds = [...new Set(overrides.map((override) => String(override.patientId || '')))].filter(Boolean)
      const invoicesByPatient = new Map<string, number>()

      await Promise.all(
        patientIds.map(async (currentPatientId) => {
          const docs = await listDocs(invoicesDb, { type: 'invoice', patientId: currentPatientId, archived: { $ne: true } })
          invoicesByPatient.set(
            currentPatientId,
            docs.reduce((sum, invoice) => sum + Math.max(toNumber(invoice.balance), 0), 0),
          )
        }),
      )

      reply.send({
        overrides: overrides.map((override) => ({
          ...override,
          outstandingBalance: invoicesByPatient.get(String(override.patientId || '')) || 0,
        })),
        count: overrides.length,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.overrides.list_failed')
      reply.code(500).send({ error: 'Failed to list billing overrides' })
    }
  })

  fastify.post('/financial/overrides', async (request, reply) => {
    try {
      const payload = request.body as any
      if (!payload?.patientId || !payload?.reason || !payload?.grantedBy) {
        reply.code(400).send({ error: 'Patient ID, reason, and grantedBy are required' })
        return
      }

      const timestamp = isoNow()
      const overrideDoc = {
        type: 'billingOverride',
        patientId: String(payload.patientId),
        privilegeType: payload.privilegeType || 'billing_exception',
        reason: payload.reason,
        grantedBy: payload.grantedBy,
        active: true,
        status: 'approved',
        approvedAmount: toNumber(payload.approvedAmount ?? payload.limitAmount),
        limitAmount: toNumber(payload.limitAmount ?? payload.approvedAmount),
        expiresAt: payload.expiresAt,
        notes: payload.notes,
        grantedAt: payload.grantedAt || timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const result = await overridesDb.insert(overrideDoc as any)
      emitFinancialUpdate(String(payload.patientId), 'override.granted', {
        overrideId: result.id,
        approvedAmount: overrideDoc.approvedAmount,
      })

      reply.code(201).send({
        ...overrideDoc,
        _id: result.id,
        _rev: result.rev,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'patient_finance.overrides.create_failed')
      reply.code(500).send({ error: 'Failed to create billing override' })
    }
  })

  fastify.post('/financial/overrides/:id/revoke', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const payload = request.body as any
      const existing = await overridesDb.get(id)

      if ((existing as any).type !== 'billingOverride') {
        reply.code(404).send({ error: 'Billing override not found' })
        return
      }

      const timestamp = isoNow()
      const updated = {
        ...existing,
        active: false,
        status: 'revoked',
        revokedAt: timestamp,
        revokedBy: payload?.revokedBy,
        revokeReason: payload?.reason || payload?.revokeReason,
        updatedAt: timestamp,
      }

      const result = await overridesDb.insert(updated)
      emitFinancialUpdate(String((existing as any).patientId || ''), 'override.revoked', {
        overrideId: id,
      })

      reply.send({
        ...updated,
        _id: result.id,
        _rev: result.rev,
      })
    } catch (error: unknown) {
      if ((error as any)?.status === 404) {
        reply.code(404).send({ error: 'Billing override not found' })
        return
      }
      fastify.log.error(error as Error, 'patient_finance.overrides.revoke_failed')
      reply.code(500).send({ error: 'Failed to revoke billing override' })
    }
  })
}
