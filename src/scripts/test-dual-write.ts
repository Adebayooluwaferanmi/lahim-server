/**
 * Dual-Write Verification Test Script
 * Tests that dual-write is working correctly for lab orders and specimens
 * 
 * Usage:
 *   ts-node src/scripts/test-dual-write.ts
 */

import { PrismaClient } from '@prisma/client'
import nano from 'nano'
import * as dotenv from 'dotenv'

dotenv.config()

const prisma = new PrismaClient()
const couchUrl = process.env.COUCHDB_URL || 'http://dev:dev@localhost:5984'
const couch = nano(couchUrl)

interface TestResult {
  test: string
  passed: boolean
  message: string
  details?: any
}

const results: TestResult[] = []

/**
 * Test lab order dual-write
 */
async function testLabOrderDualWrite(): Promise<TestResult> {
  try {
    const testOrderId = `test_order_${Date.now()}`
    const couchDb = couch.db.use('lab_orders')
    
    // Create test order in CouchDB
    const testOrder = {
      _id: testOrderId,
      type: 'lab_order',
      patientId: 'test_patient_123',
      tests: [{
        testCode: {
          coding: [{
            code: 'TEST-001',
            system: 'http://loinc.org',
            display: 'Test Order',
          }],
        },
      }],
      status: 'ordered',
      orderedOn: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    
    await couchDb.insert(testOrder)
    
    // Check if it exists in PostgreSQL
    const prismaOrder = await prisma.labOrder.findUnique({
      where: { id: testOrderId },
    })
    
    // Cleanup
    try {
      const doc = await couchDb.get(testOrderId)
      await couchDb.destroy(testOrderId, doc._rev)
    } catch {}
    
    try {
      await prisma.labOrder.delete({ where: { id: testOrderId } })
    } catch {}
    
    if (prismaOrder) {
      return {
        test: 'Lab Order Dual-Write',
        passed: true,
        message: 'Lab order successfully written to both databases',
        details: {
          couchId: testOrderId,
          postgresId: prismaOrder.id,
          status: prismaOrder.status,
        },
      }
    } else {
      return {
        test: 'Lab Order Dual-Write',
        passed: false,
        message: 'Lab order not found in PostgreSQL',
        details: { couchId: testOrderId },
      }
    }
  } catch (error: any) {
    return {
      test: 'Lab Order Dual-Write',
      passed: false,
      message: `Error: ${error.message}`,
      details: { error: error.toString() },
    }
  }
}

/**
 * Test specimen dual-write
 */
async function testSpecimenDualWrite(): Promise<TestResult> {
  try {
    const testSpecimenId = `test_specimen_${Date.now()}`
    const couchDb = couch.db.use('specimens')
    
    // Create test specimen in CouchDB
    const testSpecimen = {
      _id: testSpecimenId,
      type: 'specimen',
      orderId: 'test_order_123',
      patientId: 'test_patient_123',
      specimenTypeCode: 'BLOOD',
      collectedOn: new Date().toISOString(),
      accessionNo: `ACC-${Date.now()}`,
      status: 'collected',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    
    await couchDb.insert(testSpecimen)
    
    // Check if it exists in PostgreSQL
    const prismaSpecimen = await prisma.labSpecimen.findUnique({
      where: { id: testSpecimenId },
    })
    
    // Cleanup
    try {
      const doc = await couchDb.get(testSpecimenId)
      await couchDb.destroy(testSpecimenId, doc._rev)
    } catch {}
    
    try {
      await prisma.labSpecimen.delete({ where: { id: testSpecimenId } })
    } catch {}
    
    if (prismaSpecimen) {
      return {
        test: 'Specimen Dual-Write',
        passed: true,
        message: 'Specimen successfully written to both databases',
        details: {
          couchId: testSpecimenId,
          postgresId: prismaSpecimen.id,
          accessionNo: prismaSpecimen.accessionNo,
        },
      }
    } else {
      return {
        test: 'Specimen Dual-Write',
        passed: false,
        message: 'Specimen not found in PostgreSQL',
        details: { couchId: testSpecimenId },
      }
    }
  } catch (error: any) {
    return {
      test: 'Specimen Dual-Write',
      passed: false,
      message: `Error: ${error.message}`,
      details: { error: error.toString() },
    }
  }
}

/**
 * Test data consistency between databases
 */
async function testDataConsistency(): Promise<TestResult> {
  try {
    const couchDb = couch.db.use('lab_orders')
    
    // Get a sample of lab orders from CouchDB
    const couchResult = await couchDb.find({
      selector: { type: 'lab_order' },
      limit: 10,
    })
    
    if (couchResult.docs.length === 0) {
      return {
        test: 'Data Consistency',
        passed: true,
        message: 'No data to compare (empty database)',
      }
    }
    
    let matched = 0
    let notFound = 0
    const missing: string[] = []
    
    for (const doc of couchResult.docs) {
      const orderId = (doc as any)._id
      const prismaOrder = await prisma.labOrder.findUnique({
        where: { id: orderId },
      })
      
      if (prismaOrder) {
        matched++
      } else {
        notFound++
        missing.push(orderId)
      }
    }
    
    const consistencyRate = (matched / couchResult.docs.length) * 100
    
    return {
      test: 'Data Consistency',
      passed: consistencyRate >= 80, // At least 80% consistency
      message: `Data consistency: ${consistencyRate.toFixed(2)}%`,
      details: {
        total: couchResult.docs.length,
        matched,
        notFound,
        missing: missing.slice(0, 5), // Show first 5 missing
      },
    }
  } catch (error: any) {
    return {
      test: 'Data Consistency',
      passed: false,
      message: `Error: ${error.message}`,
      details: { error: error.toString() },
    }
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('='.repeat(60))
  console.log('Dual-Write Verification Tests')
  console.log('='.repeat(60))
  console.log('')
  
  console.log('Running tests...')
  console.log('')
  
  // Test 1: Lab Order Dual-Write
  console.log('1. Testing Lab Order Dual-Write...')
  const labOrderTest = await testLabOrderDualWrite()
  results.push(labOrderTest)
  console.log(`   ${labOrderTest.passed ? '✓' : '✗'} ${labOrderTest.message}`)
  console.log('')
  
  // Test 2: Specimen Dual-Write
  console.log('2. Testing Specimen Dual-Write...')
  const specimenTest = await testSpecimenDualWrite()
  results.push(specimenTest)
  console.log(`   ${specimenTest.passed ? '✓' : '✗'} ${specimenTest.message}`)
  console.log('')
  
  // Test 3: Data Consistency
  console.log('3. Testing Data Consistency...')
  const consistencyTest = await testDataConsistency()
  results.push(consistencyTest)
  console.log(`   ${consistencyTest.passed ? '✓' : '✗'} ${consistencyTest.message}`)
  console.log('')
  
  // Print summary
  console.log('='.repeat(60))
  console.log('Test Summary')
  console.log('='.repeat(60))
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  
  console.log(`Total Tests: ${results.length}`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log('')
  
  if (failed > 0) {
    console.log('Failed Tests:')
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.test}: ${r.message}`)
      if (r.details) {
        console.log(`    Details: ${JSON.stringify(r.details, null, 2)}`)
      }
    })
  }
  
  console.log('='.repeat(60))
  
  await prisma.$disconnect()
  
  process.exit(failed > 0 ? 1 : 0)
}

// Run tests
if (require.main === module) {
  runTests().catch((error) => {
    console.error('Test execution failed:', error)
    process.exit(1)
  })
}

export { testLabOrderDualWrite, testSpecimenDualWrite, testDataConsistency }

