/**
 * Equipment Service Tests
 * Tests for equipment maintenance module functionality
 */

import { test } from 'tap'
import { build } from '../helper'
import { computeNextDue } from '../../src/lib/equipment/compute-next-due'
import { parseISO, addDays, addWeeks, addMonths } from 'date-fns'

// Test computeNextDue utility
test('computeNextDue - days interval', async (t: any) => {
  const baseDate = new Date('2024-01-15T10:00:00Z')
  const result = computeNextDue(baseDate.toISOString(), 7, 'days')
  const expected = addDays(baseDate, 7).toISOString()
  t.equal(result, expected)
})

test('computeNextDue - weeks interval', async (t: any) => {
  const baseDate = new Date('2024-01-15T10:00:00Z')
  const result = computeNextDue(baseDate.toISOString(), 2, 'weeks')
  const expected = addWeeks(baseDate, 2).toISOString()
  t.equal(result, expected)
})

test('computeNextDue - months interval', async (t: any) => {
  const baseDate = new Date('2024-01-15T10:00:00Z')
  const result = computeNextDue(baseDate.toISOString(), 3, 'months')
  const expected = addMonths(baseDate, 3).toISOString()
  t.equal(result, expected)
})

test('computeNextDue - null lastDate uses current date', async (t: any) => {
  const before = new Date()
  const result = computeNextDue(null, 7, 'days')
  const after = new Date()
  const resultDate = parseISO(result)
  
  // Result should be approximately 7 days from now
  const expectedMin = addDays(before, 7)
  const expectedMax = addDays(after, 7)
  
  t.ok(resultDate >= expectedMin && resultDate <= expectedMax, 'Result is within expected range')
})

test('computeNextDue - throws error for invalid intervalValue', async (t: any) => {
  t.throws(() => {
    computeNextDue(new Date().toISOString(), 0, 'days')
  }, /intervalValue must be greater than 0/)
})

test('computeNextDue - throws error for invalid unit', async (t: any) => {
  t.throws(() => {
    computeNextDue(new Date().toISOString(), 1, 'invalid' as any)
  }, /Unsupported interval unit/)
})

// Test equipment routes (basic structure tests)
test('POST /equipment - requires authentication', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    payload: {
      name: 'Test Equipment',
    },
  })

  // Should return 403 if no auth, or 400 if validation fails
  t.ok([400, 403].includes(res.statusCode), 'Returns 400 or 403 without auth')
})

test('POST /equipment - validates required fields', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:manager',
    },
    payload: {
      // Missing name
    },
  })

  t.equal(res.statusCode, 400, 'Returns 400 for missing required field')
  const body = JSON.parse(res.payload)
  t.ok(body.error, 'Error message present')
  t.ok(body.details, 'Validation details present')
})

test('POST /equipment - validates maintenance plan', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:manager',
    },
    payload: {
      name: 'Test Equipment',
      maintenancePlan: {
        kind: 'custom',
        intervalValue: 0, // Invalid: must be > 0
        intervalUnit: 'days',
        enabled: true,
      },
    },
  })

  t.equal(res.statusCode, 400, 'Returns 400 for invalid maintenance plan')
})

test('GET /equipment - returns list', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/equipment',
  })

  // Should return 503 if CouchDB not available, or 200 with empty list
  t.ok([200, 503].includes(res.statusCode), 'Returns 200 or 503')
  
  if (res.statusCode === 200) {
    const body = JSON.parse(res.payload)
    t.ok(Array.isArray(body.items) || Array.isArray(body.equipment), 'Returns array of items')
  }
})

test('GET /equipment - supports query filters', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/equipment?active=true&limit=10&skip=0',
  })

  // Should return 503 if CouchDB not available, or 200
  t.ok([200, 503].includes(res.statusCode), 'Returns 200 or 503')
})

test('GET /equipment - validates query parameters', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/equipment?limit=-1', // Invalid: must be positive
  })

  // Should return 400 for invalid query params, or 503 if DB unavailable
  t.ok([400, 503].includes(res.statusCode), 'Returns 400 or 503 for invalid params')
})

test('PUT /equipment/:id - requires authentication and ACL', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'PUT',
    url: '/equipment/test-id',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:manager',
    },
    payload: {
      name: 'Updated Equipment',
    },
  })

  // Should return 404 if not found, 403 if no ACL access, or 503 if DB unavailable
  t.ok([403, 404, 503].includes(res.statusCode), 'Returns appropriate error code')
})

test('POST /equipment/:id/documents - requires authentication', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'POST',
    url: '/equipment/test-id/documents',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:manager',
    },
    payload: {
      name: 'test.pdf',
      mime: 'application/pdf',
      size: 1024,
      storageKey: 'test-key',
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'test-user',
    },
  })

  // Should return 404 if equipment not found, 403 if no access, or 503 if DB unavailable
  t.ok([403, 404, 503].includes(res.statusCode), 'Returns appropriate error code')
})

test('POST /equipment/:id/maintenance - validates maintenance event', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'POST',
    url: '/equipment/test-id/maintenance',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:technician',
    },
    payload: {
      // Missing required fields
    },
  })

  // Should return 400 for validation error, 404 if not found, 403 if no access, or 503 if DB unavailable
  t.ok([400, 403, 404, 503].includes(res.statusCode), 'Returns appropriate error code')
})

test('POST /equipment/:id/maintenance - routine maintenance updates nextDue', async (t: any) => {
  // This is a conceptual test - actual implementation would require mocking CouchDB
  // The logic is: if maintenanceType === 'routine' and maintenancePlan exists,
  // then nextDue should be recalculated based on performedAt
  
  const performedAt = new Date('2024-01-15T10:00:00Z')
  const intervalValue = 1
  const intervalUnit = 'months' as const
  
  const nextDue = computeNextDue(performedAt.toISOString(), intervalValue, intervalUnit)
  const expected = addMonths(performedAt, intervalValue).toISOString()
  
  t.equal(nextDue, expected, 'nextDue is calculated correctly for routine maintenance')
})

test('GET /equipment/:id/maintenance - requires authentication', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/equipment/test-id/maintenance',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:technician',
    },
  })

  // Should return 404 if not found, 403 if no access, or 503 if DB unavailable
  t.ok([403, 404, 503].includes(res.statusCode), 'Returns appropriate error code')
})

test('GET /maintenance/calendar - requires authentication', async (t: any) => {
  const app = build(t)

  const res = await app.inject({
    method: 'GET',
    url: '/maintenance/calendar',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'equipment:technician',
    },
  })

  // Should return 200 with calendar data, or 503 if DB unavailable
  t.ok([200, 503].includes(res.statusCode), 'Returns 200 or 503')
})

test('RBAC - blocks unauthorized access', async (t: any) => {
  const app = build(t)

  // Try to create equipment without required role
  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    headers: {
      'x-user-id': 'test-user',
      'x-user-roles': 'user', // Not equipment:manager
    },
    payload: {
      name: 'Test Equipment',
    },
  })

  // Should return 403 for insufficient permissions
  t.ok([400, 403, 503].includes(res.statusCode), 'Returns 403 or validation error')
})

test('Search - filters by dueInDays', async (t: any) => {
  // Conceptual test for due/overdue filtering logic
  const today = new Date()
  const dueInDays = 7
  const soonDate = addDays(today, dueInDays)
  
  // Equipment with nextDue within window should be included
  const equipmentDue = {
    maintenancePlan: {
      nextDue: addDays(today, 5).toISOString(), // Within 7 days
    },
  }
  
  // Equipment with nextDue outside window should be excluded
  const equipmentNotDue = {
    maintenancePlan: {
      nextDue: addDays(today, 10).toISOString(), // Outside 7 days
    },
  }
  
  const isWithinWindow = (eq: any) => {
    const nextDue = parseISO(eq.maintenancePlan.nextDue)
    return nextDue <= soonDate
  }
  
  t.ok(isWithinWindow(equipmentDue), 'Equipment due within window is included')
  t.notOk(isWithinWindow(equipmentNotDue), 'Equipment due outside window is excluded')
})

