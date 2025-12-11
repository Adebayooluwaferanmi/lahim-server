/**
 * Populate TestCatalog with existing test codes from database
 * This script extracts all unique test codes from LabOrder, LabResult, QcResult, and WorklistItem
 * and creates TestCatalog entries for them.
 * 
 * Usage:
 *   ts-node -r dotenv/config src/scripts/populate-test-catalog.ts
 */

import { PrismaClient } from '@prisma/client'
import * as dotenv from 'dotenv'

dotenv.config()

const prisma = new PrismaClient()

async function populateTestCatalog() {
  console.log('='.repeat(60))
  console.log('Populating TestCatalog with existing test codes')
  console.log('='.repeat(60))
  console.log('')

  try {
    // Get all unique test codes from LabOrder
    console.log('Extracting test codes from LabOrder...')
    const labOrderCodes = await prisma.labOrder.findMany({
      select: { testCodeLoinc: true },
      distinct: ['testCodeLoinc'],
    })
    console.log(`Found ${labOrderCodes.length} unique test codes in LabOrder`)

    // Get all unique test codes from LabResult
    console.log('Extracting test codes from LabResult...')
    const labResultCodes = await prisma.labResult.findMany({
      select: { analyteCodeLoinc: true },
      distinct: ['analyteCodeLoinc'],
    })
    console.log(`Found ${labResultCodes.length} unique test codes in LabResult`)

    // Get all unique test codes from QcResult
    console.log('Extracting test codes from QcResult...')
    const qcResultCodes = await prisma.qcResult.findMany({
      select: { testCodeLoinc: true },
      distinct: ['testCodeLoinc'],
    })
    console.log(`Found ${qcResultCodes.length} unique test codes in QcResult`)

    // Get all unique test codes from WorklistItem
    console.log('Extracting test codes from WorklistItem...')
    const worklistItemCodes = await prisma.worklistItem.findMany({
      select: { testCodeLoinc: true },
      distinct: ['testCodeLoinc'],
    })
    console.log(`Found ${worklistItemCodes.length} unique test codes in WorklistItem`)

    // Combine all unique test codes
    const allCodes = new Set<string>()
    labOrderCodes.forEach((o) => {
      if (o.testCodeLoinc) allCodes.add(o.testCodeLoinc)
    })
    labResultCodes.forEach((r) => allCodes.add(r.analyteCodeLoinc))
    qcResultCodes.forEach((q) => {
      if (q.testCodeLoinc) allCodes.add(q.testCodeLoinc)
    })
    worklistItemCodes.forEach((w) => {
      if (w.testCodeLoinc) allCodes.add(w.testCodeLoinc)
    })

    console.log(`\nTotal unique test codes found: ${allCodes.size}`)
    console.log('')

    // Check which codes already exist in TestCatalog
    const existingCodes = await prisma.testCatalog.findMany({
      select: { code: true },
    })
    const existingCodeSet = new Set(existingCodes.map((t) => t.code))

    const codesToCreate = Array.from(allCodes).filter((code) => !existingCodeSet.has(code))
    console.log(`Codes already in TestCatalog: ${existingCodeSet.size}`)
    console.log(`Codes to create: ${codesToCreate.length}`)
    console.log('')

    if (codesToCreate.length === 0) {
      console.log('No new test codes to add. TestCatalog is up to date.')
      return
    }

    // Create TestCatalog entries
    console.log('Creating TestCatalog entries...')
    let created = 0
    let errors = 0

    for (const code of codesToCreate) {
      try {
        // Generate a UUID for the id
        const id = `test_catalog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

        await prisma.testCatalog.create({
          data: {
            id,
            code,
            name: code, // Use code as name if we don't have a better name
            active: true,
          },
        })

        created++

        if (created % 10 === 0) {
          console.log(`Created ${created}/${codesToCreate.length} entries...`)
        }
      } catch (error) {
        console.error(`Error creating TestCatalog entry for code ${code}:`, error)
        errors++
      }
    }

    console.log('')
    console.log('='.repeat(60))
    console.log('Summary')
    console.log('='.repeat(60))
    console.log(`Total unique test codes: ${allCodes.size}`)
    console.log(`Already existed: ${existingCodeSet.size}`)
    console.log(`Created: ${created}`)
    console.log(`Errors: ${errors}`)
    console.log('='.repeat(60))
  } catch (error) {
    console.error('Error populating TestCatalog:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Run the script
if (require.main === module) {
  populateTestCatalog()
    .then(() => {
      console.log('\n✅ TestCatalog population complete!')
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n❌ TestCatalog population failed:', error)
      process.exit(1)
    })
}

export default populateTestCatalog

