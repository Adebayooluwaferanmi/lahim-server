/**
 * Data Migration Script
 * Migrates existing CouchDB data to PostgreSQL
 * 
 * Usage:
 *   ts-node src/scripts/migrate-couchdb-to-postgres.ts [database-name]
 * 
 * Examples:
 *   ts-node src/scripts/migrate-couchdb-to-postgres.ts lab_orders
 *   ts-node src/scripts/migrate-couchdb-to-postgres.ts specimens
 *   ts-node src/scripts/migrate-couchdb-to-postgres.ts all
 */

import { PrismaClient } from '@prisma/client'
import nano from 'nano'
import * as dotenv from 'dotenv'
import { mapCouchToPrismaLabOrder } from '../lib/mappers/lab-order-mapper'
import { mapCouchToPrismaSpecimen } from '../lib/mappers/specimen-mapper'
import { mapCouchToPrismaResult } from '../lib/mappers/result-mapper'

dotenv.config()

const prisma = new PrismaClient()

// CouchDB connection
const couchUrl = process.env.COUCHDB_URL || 'http://dev:dev@localhost:5984'
const couch = nano(couchUrl)

interface MigrationStats {
  total: number
  migrated: number
  errors: number
  skipped: number
}

/**
 * Migrate lab orders from CouchDB to PostgreSQL
 */
async function migrateLabOrders(): Promise<MigrationStats> {
  const stats: MigrationStats = { total: 0, migrated: 0, errors: 0, skipped: 0 }
  
  console.log('Starting lab orders migration...')
  
  try {
    const db = couch.db.use('lab_orders')
    
    // Get all documents
    const allDocs = await db.list({ include_docs: true })
    stats.total = allDocs.rows.length
    
    console.log(`Found ${stats.total} lab orders to migrate`)
    
    for (const row of allDocs.rows) {
      const doc = row.doc as any
      
      // Skip design documents and non-lab-order documents
      if (doc._id?.startsWith('_design') || doc.type !== 'lab_order') {
        stats.skipped++
        continue
      }
      
      try {
        // Map to Prisma format
        const prismaData = mapCouchToPrismaLabOrder(doc)
        
        // Upsert to PostgreSQL
        await prisma.labOrder.upsert({
          where: { id: prismaData.id },
          create: prismaData,
          update: prismaData,
        })
        
        stats.migrated++
        
        if (stats.migrated % 100 === 0) {
          console.log(`Migrated ${stats.migrated}/${stats.total} lab orders...`)
        }
      } catch (error) {
        console.error(`Error migrating lab order ${doc._id}:`, error)
        stats.errors++
      }
    }
    
    console.log(`Lab orders migration complete: ${stats.migrated} migrated, ${stats.errors} errors, ${stats.skipped} skipped`)
  } catch (error) {
    console.error('Error during lab orders migration:', error)
    throw error
  }
  
  return stats
}

/**
 * Migrate specimens from CouchDB to PostgreSQL
 */
async function migrateSpecimens(): Promise<MigrationStats> {
  const stats: MigrationStats = { total: 0, migrated: 0, errors: 0, skipped: 0 }
  
  console.log('Starting specimens migration...')
  
  try {
    const db = couch.db.use('specimens')
    
    // Get all documents
    const allDocs = await db.list({ include_docs: true })
    stats.total = allDocs.rows.length
    
    console.log(`Found ${stats.total} specimens to migrate`)
    
    for (const row of allDocs.rows) {
      const doc = row.doc as any
      
      // Skip design documents and non-specimen documents
      if (doc._id?.startsWith('_design') || doc.type !== 'specimen') {
        stats.skipped++
        continue
      }
      
      try {
        // Map to Prisma format
        const prismaData = mapCouchToPrismaSpecimen(doc)
        
        // Upsert to PostgreSQL
        await prisma.labSpecimen.upsert({
          where: { id: prismaData.id },
          create: prismaData,
          update: prismaData,
        })
        
        stats.migrated++
        
        if (stats.migrated % 100 === 0) {
          console.log(`Migrated ${stats.migrated}/${stats.total} specimens...`)
        }
      } catch (error) {
        console.error(`Error migrating specimen ${doc._id}:`, error)
        stats.errors++
      }
    }
    
    console.log(`Specimens migration complete: ${stats.migrated} migrated, ${stats.errors} errors, ${stats.skipped} skipped`)
  } catch (error) {
    console.error('Error during specimens migration:', error)
    throw error
  }
  
  return stats
}

/**
 * Migrate lab results from CouchDB to PostgreSQL
 */
async function migrateLabResults(): Promise<MigrationStats> {
  const stats: MigrationStats = { total: 0, migrated: 0, errors: 0, skipped: 0 }
  
  console.log('Starting lab results migration...')
  
  try {
    const db = couch.db.use('lab_results')
    
    // Get all documents
    const allDocs = await db.list({ include_docs: true })
    stats.total = allDocs.rows.length
    
    console.log(`Found ${stats.total} lab results to migrate`)
    
    for (const row of allDocs.rows) {
      const doc = row.doc as any
      
      // Skip design documents and non-lab-result documents
      if (doc._id?.startsWith('_design') || doc.type !== 'lab_result') {
        stats.skipped++
        continue
      }
      
      try {
        // Map to Prisma format
        const prismaData = mapCouchToPrismaResult(doc)
        
        // Upsert to PostgreSQL
        await prisma.labResult.upsert({
          where: { id: prismaData.id },
          create: prismaData,
          update: prismaData,
        })
        
        stats.migrated++
        
        if (stats.migrated % 100 === 0) {
          console.log(`Migrated ${stats.migrated}/${stats.total} lab results...`)
        }
      } catch (error) {
        console.error(`Error migrating lab result ${doc._id}:`, error)
        stats.errors++
      }
    }
    
    console.log(`Lab results migration complete: ${stats.migrated} migrated, ${stats.errors} errors, ${stats.skipped} skipped`)
  } catch (error) {
    console.error('Error during lab results migration:', error)
    throw error
  }
  
  return stats
}

/**
 * Main migration function
 */
async function main() {
  const database = process.argv[2] || 'all'
  
  console.log('='.repeat(60))
  console.log('CouchDB to PostgreSQL Migration Script')
  console.log('='.repeat(60))
  console.log(`Target database: ${database}`)
  console.log('')
  
  const allStats: { [key: string]: MigrationStats } = {}
  
  try {
    if (database === 'all' || database === 'lab_orders') {
      allStats.lab_orders = await migrateLabOrders()
      console.log('')
    }
    
    if (database === 'all' || database === 'specimens') {
      allStats.specimens = await migrateSpecimens()
      console.log('')
    }
    
    if (database === 'all' || database === 'lab_results') {
      allStats.lab_results = await migrateLabResults()
      console.log('')
    }
    
    // Print summary
    console.log('='.repeat(60))
    console.log('Migration Summary')
    console.log('='.repeat(60))
    
    let totalMigrated = 0
    let totalErrors = 0
    let totalSkipped = 0
    let totalDocs = 0
    
    for (const [db, stats] of Object.entries(allStats)) {
      console.log(`${db}:`)
      console.log(`  Total: ${stats.total}`)
      console.log(`  Migrated: ${stats.migrated}`)
      console.log(`  Errors: ${stats.errors}`)
      console.log(`  Skipped: ${stats.skipped}`)
      console.log('')
      
      totalDocs += stats.total
      totalMigrated += stats.migrated
      totalErrors += stats.errors
      totalSkipped += stats.skipped
    }
    
    console.log('Overall:')
    console.log(`  Total Documents: ${totalDocs}`)
    console.log(`  Successfully Migrated: ${totalMigrated}`)
    console.log(`  Errors: ${totalErrors}`)
    console.log(`  Skipped: ${totalSkipped}`)
    console.log(`  Success Rate: ${totalDocs > 0 ? ((totalMigrated / totalDocs) * 100).toFixed(2) : 0}%`)
    console.log('='.repeat(60))
    
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

// Run migration
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error)
    process.exit(1)
  })
}

export { migrateLabOrders, migrateSpecimens, migrateLabResults }

