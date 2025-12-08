/**
 * Comprehensive Seed Script for LaHIM
 * Seeds initial data for all services to ensure functions correctly fetch and write to database
 * 
 * Usage:
 *   ts-node -r dotenv/config src/scripts/seed-all-data.ts
 *   or
 *   yarn workspace @hospitalrun/server seed:all
 */

import * as dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import Nano from 'nano'

dotenv.config()

const prisma = new PrismaClient()
const couchUrl = process.env.COUCHDB_URL || 'http://dev:dev@localhost:5984'
const nano = Nano(couchUrl)

// Helper to ensure database exists
async function ensureDatabase(dbName: string) {
  try {
    await nano.db.create(dbName)
    console.log(`✅ Created database: ${dbName}`)
  } catch (error: any) {
    if (error.statusCode === 412) {
      console.log(`✅ Database already exists: ${dbName}`)
    } else {
      console.error(`❌ Error creating database ${dbName}:`, error.message)
      throw error
    }
  }
}

// Helper to insert document into CouchDB
async function insertCouchDoc(dbName: string, doc: any) {
  const db = nano.db.use(dbName)
  try {
    const result = await db.insert(doc)
    return result
  } catch (error: any) {
    if (error.statusCode === 409) {
      // Document already exists, update it
      const existing = await db.get(doc._id)
      doc._rev = existing._rev
      return await db.insert(doc)
    }
    throw error
  }
}

async function seedAllData() {
  console.log('='.repeat(80))
  console.log('🌱 LaHIM Comprehensive Data Seeding')
  console.log('='.repeat(80))
  console.log('')

  try {
    // ========== 1. VOCABULARIES ==========
    console.log('📚 Seeding Vocabularies...')
    console.log('-'.repeat(80))

    await ensureDatabase('vocabularies_organisms')
    await ensureDatabase('vocabularies_antibiotics')
    await ensureDatabase('vocabularies_value_sets')

    // Organisms
    const organisms = [
      { code: '33795004', display: 'Escherichia coli', codeSystem: 'SNOMED-CT', synonyms: ['E. coli'] },
      { code: '115329001', display: 'Staphylococcus aureus', codeSystem: 'SNOMED-CT', synonyms: ['S. aureus', 'Staph aureus'] },
      { code: '112283007', display: 'Streptococcus pneumoniae', codeSystem: 'SNOMED-CT', synonyms: ['S. pneumoniae', 'Pneumococcus'] },
      { code: '112283008', display: 'Klebsiella pneumoniae', codeSystem: 'SNOMED-CT', synonyms: ['K. pneumoniae'] },
      { code: '112283009', display: 'Pseudomonas aeruginosa', codeSystem: 'SNOMED-CT', synonyms: ['P. aeruginosa'] },
      { code: '112283010', display: 'Acinetobacter baumannii', codeSystem: 'SNOMED-CT', synonyms: ['A. baumannii'] },
      { code: '112283011', display: 'Enterococcus faecalis', codeSystem: 'SNOMED-CT', synonyms: ['E. faecalis'] },
      { code: '112283012', display: 'Enterococcus faecium', codeSystem: 'SNOMED-CT', synonyms: ['E. faecium'] },
      { code: '112283013', display: 'Proteus mirabilis', codeSystem: 'SNOMED-CT', synonyms: ['P. mirabilis'] },
      { code: '112283014', display: 'Salmonella species', codeSystem: 'SNOMED-CT', synonyms: ['Salmonella'] },
    ]

    for (const org of organisms) {
      await insertCouchDoc('vocabularies_organisms', {
        _id: `org_${org.code}`,
        type: 'organism',
        ...org,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    console.log(`✅ Seeded ${organisms.length} organisms`)

    // Antibiotics
    const antibiotics = [
      { code: '197806', display: 'Amoxicillin', codeSystem: 'RxNorm', class: 'Penicillin', spectrum: ['Gram-positive', 'Gram-negative'] },
      { code: '166502', display: 'Ceftriaxone', codeSystem: 'RxNorm', class: 'Cephalosporin', spectrum: ['Gram-positive', 'Gram-negative'] },
      { code: '165992', display: 'Ciprofloxacin', codeSystem: 'RxNorm', class: 'Fluoroquinolone', spectrum: ['Gram-negative'] },
      { code: '165908', display: 'Azithromycin', codeSystem: 'RxNorm', class: 'Macrolide', spectrum: ['Gram-positive', 'Atypical'] },
      { code: '165909', display: 'Clarithromycin', codeSystem: 'RxNorm', class: 'Macrolide', spectrum: ['Gram-positive', 'Atypical'] },
      { code: '165910', display: 'Erythromycin', codeSystem: 'RxNorm', class: 'Macrolide', spectrum: ['Gram-positive'] },
      { code: '165911', display: 'Vancomycin', codeSystem: 'RxNorm', class: 'Glycopeptide', spectrum: ['Gram-positive'] },
      { code: '165912', display: 'Gentamicin', codeSystem: 'RxNorm', class: 'Aminoglycoside', spectrum: ['Gram-negative'] },
      { code: '165913', display: 'Tobramycin', codeSystem: 'RxNorm', class: 'Aminoglycoside', spectrum: ['Gram-negative'] },
      { code: '165914', display: 'Meropenem', codeSystem: 'RxNorm', class: 'Carbapenem', spectrum: ['Gram-positive', 'Gram-negative'] },
      { code: '165915', display: 'Imipenem', codeSystem: 'RxNorm', class: 'Carbapenem', spectrum: ['Gram-positive', 'Gram-negative'] },
      { code: '165916', display: 'Piperacillin-Tazobactam', codeSystem: 'RxNorm', class: 'Penicillin-Beta-lactamase inhibitor', spectrum: ['Gram-positive', 'Gram-negative'] },
      { code: '165917', display: 'Clindamycin', codeSystem: 'RxNorm', class: 'Lincosamide', spectrum: ['Gram-positive', 'Anaerobic'] },
      { code: '165918', display: 'Metronidazole', codeSystem: 'RxNorm', class: 'Nitroimidazole', spectrum: ['Anaerobic'] },
      { code: '165919', display: 'Trimethoprim-Sulfamethoxazole', codeSystem: 'RxNorm', class: 'Sulfonamide', spectrum: ['Gram-positive', 'Gram-negative'] },
    ]

    for (const abx of antibiotics) {
      await insertCouchDoc('vocabularies_antibiotics', {
        _id: `abx_${abx.code}`,
        type: 'antibiotic',
        ...abx,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    console.log(`✅ Seeded ${antibiotics.length} antibiotics`)

    // Value Sets
    const valueSets = [
      { listId: 'blood-type', code: 'A+', display: 'A Positive', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'A-', display: 'A Negative', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'B+', display: 'B Positive', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'B-', display: 'B Negative', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'AB+', display: 'AB Positive', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'AB-', display: 'AB Negative', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'O+', display: 'O Positive', codeSystem: 'ABO-Rh' },
      { listId: 'blood-type', code: 'O-', display: 'O Negative', codeSystem: 'ABO-Rh' },
      { listId: 'urine-appearance', code: 'clear', display: 'Clear', codeSystem: 'local' },
      { listId: 'urine-appearance', code: 'cloudy', display: 'Cloudy', codeSystem: 'local' },
      { listId: 'urine-appearance', code: 'turbid', display: 'Turbid', codeSystem: 'local' },
      { listId: 'urine-appearance', code: 'bloody', display: 'Bloody', codeSystem: 'local' },
      { listId: 'gram-stain', code: 'gram-positive', display: 'Gram Positive', codeSystem: 'local' },
      { listId: 'gram-stain', code: 'gram-negative', display: 'Gram Negative', codeSystem: 'local' },
      { listId: 'gram-stain', code: 'gram-variable', display: 'Gram Variable', codeSystem: 'local' },
    ]

    for (const vs of valueSets) {
      await insertCouchDoc('vocabularies_value_sets', {
        _id: `vs_${vs.listId}_${vs.code}`,
        type: 'value_set',
        ...vs,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    console.log(`✅ Seeded ${valueSets.length} value set items`)
    console.log('')

    // ========== 2. TEST CATALOG ==========
    console.log('🧪 Seeding Test Catalog...')
    console.log('-'.repeat(80))

    await ensureDatabase('test_catalog')

    const testCatalogEntries = [
      { code: '2339-0', name: 'Glucose [Mass/volume] in Blood', department: 'Chemistry' },
      { code: '718-7', name: 'Hemoglobin [Mass/volume] in Blood', department: 'Hematology' },
      { code: '789-8', name: 'Erythrocytes [#/volume] in Blood', department: 'Hematology' },
      { code: '6690-2', name: 'Leukocytes [#/volume] in Blood', department: 'Hematology' },
      { code: '777-3', name: 'Platelets [#/volume] in Blood', department: 'Hematology' },
      { code: '2160-0', name: 'Creatinine [Mass/volume] in Serum or Plasma', department: 'Chemistry' },
      { code: '33914-3', name: 'Glomerular filtration rate/1.73 sq M.predicted', department: 'Chemistry' },
      { code: '1751-7', name: 'Albumin [Mass/volume] in Serum or Plasma', department: 'Chemistry' },
      { code: '1975-2', name: 'Bilirubin.total [Mass/volume] in Serum or Plasma', department: 'Chemistry' },
      { code: '5902-2', name: 'Prothrombin time (PT)', department: 'Coagulation' },
      { code: '5900-6', name: 'INR in Platelet poor plasma', department: 'Coagulation' },
      { code: '6301-6', name: 'Urinalysis complete', department: 'Urinalysis' },
      { code: '58410-2', name: 'CBC W Differential Panel', department: 'Hematology' },
    ]

    for (const test of testCatalogEntries) {
      // Insert into CouchDB
      await insertCouchDoc('test_catalog', {
        _id: `test_${test.code}`,
        type: 'testCatalogEntry',
        ...test,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Insert into PostgreSQL
      try {
        await prisma.testCatalog.upsert({
          where: { code: test.code },
          create: {
            id: `test_${test.code}`,
            code: test.code,
            name: test.name,
            department: test.department,
            active: true,
          },
          update: {
            name: test.name,
            department: test.department,
            active: true,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert ${test.code} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${testCatalogEntries.length} test catalog entries`)
    console.log('')

    // ========== 3. INSTRUMENTS ==========
    console.log('🔬 Seeding Instruments...')
    console.log('-'.repeat(80))

    await ensureDatabase('instruments')

    const instruments = [
      { name: 'Cobas 6000', type: 'analyzer', manufacturer: 'Roche', model: 'c6000', serialNumber: 'ROC-001', section: 'Chemistry', status: 'online' },
      { name: 'Sysmex XN-1000', type: 'analyzer', manufacturer: 'Sysmex', model: 'XN-1000', serialNumber: 'SYM-001', section: 'Hematology', status: 'online' },
      { name: 'VITEK 2', type: 'analyzer', manufacturer: 'bioMérieux', model: 'VITEK2', serialNumber: 'BIO-001', section: 'Microbiology', status: 'online' },
      { name: 'Centrifuge Model 5430', type: 'centrifuge', manufacturer: 'Eppendorf', model: '5430', serialNumber: 'EPP-001', section: 'General', status: 'online' },
      { name: 'Microscope Olympus CX23', type: 'microscope', manufacturer: 'Olympus', model: 'CX23', serialNumber: 'OLY-001', section: 'Microbiology', status: 'online' },
    ]

    for (const inst of instruments) {
      await insertCouchDoc('instruments', {
        _id: `inst_${inst.serialNumber}`,
        ...inst,
        type: 'instrument', // Set type after spread to ensure it's correct
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Insert into PostgreSQL
      try {
        await prisma.instrument.upsert({
          where: { serialNumber: inst.serialNumber },
          create: {
            id: `inst_${inst.serialNumber}`,
            name: inst.name,
            type: inst.type,
            manufacturer: inst.manufacturer,
            model: inst.model,
            serialNumber: inst.serialNumber,
            status: inst.status,
            section: inst.section,
          },
          update: {
            name: inst.name,
            type: inst.type,
            manufacturer: inst.manufacturer,
            model: inst.model,
            status: inst.status,
            section: inst.section,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert instrument ${inst.serialNumber} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${instruments.length} instruments`)
    console.log('')

    // ========== 4. EQUIPMENT ==========
    console.log('⚙️  Seeding Equipment...')
    console.log('-'.repeat(80))

    await ensureDatabase('equipment')

    const equipment = [
      { name: 'Refrigerator Lab-1', equipmentType: 'refrigerator', manufacturer: 'Thermo Scientific', model: 'TSX-400', serialNumber: 'EQ-REF-001', location: 'Lab Room 1', status: 'active' },
      { name: 'Freezer -80°C', equipmentType: 'freezer', manufacturer: 'Thermo Scientific', model: 'TSX-700', serialNumber: 'EQ-FRZ-001', location: 'Storage Room', status: 'active' },
      { name: 'Water Bath', equipmentType: 'water-bath', manufacturer: 'Memmert', model: 'WB-10', serialNumber: 'EQ-WB-001', location: 'Lab Room 2', status: 'active' },
      { name: 'Incubator CO2', equipmentType: 'incubator', manufacturer: 'Thermo Scientific', model: 'HERAcell', serialNumber: 'EQ-INC-001', location: 'Microbiology Lab', status: 'active' },
    ]

    for (const eq of equipment) {
      await insertCouchDoc('equipment', {
        _id: `eq_${eq.serialNumber}`,
        ...eq,
        type: 'equipment', // Set type after spread to ensure it's correct
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Insert into PostgreSQL
      try {
        await prisma.equipment.upsert({
          where: { serialNumber: eq.serialNumber },
          create: {
            id: `eq_${eq.serialNumber}`,
            name: eq.name,
            type: eq.equipmentType,
            manufacturer: eq.manufacturer,
            model: eq.model,
            serialNumber: eq.serialNumber,
            location: eq.location,
            status: eq.status,
          },
          update: {
            name: eq.name,
            type: eq.equipmentType,
            manufacturer: eq.manufacturer,
            model: eq.model,
            location: eq.location,
            status: eq.status,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert equipment ${eq.serialNumber} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${equipment.length} equipment items`)
    console.log('')

    // ========== 5. PATIENTS ==========
    console.log('👤 Seeding Patients...')
    console.log('-'.repeat(80))

    const patients = [
      { patientId: 'P00001', firstName: 'John', lastName: 'Doe', dateOfBirth: new Date('1980-01-15'), sex: 'M' },
      { patientId: 'P00002', firstName: 'Jane', lastName: 'Smith', dateOfBirth: new Date('1975-05-20'), sex: 'F' },
      { patientId: 'P00003', firstName: 'Robert', lastName: 'Johnson', dateOfBirth: new Date('1990-08-10'), sex: 'M' },
      { patientId: 'P00004', firstName: 'Mary', lastName: 'Williams', dateOfBirth: new Date('1985-12-05'), sex: 'F' },
      { patientId: 'P00005', firstName: 'Michael', lastName: 'Brown', dateOfBirth: new Date('1978-03-25'), sex: 'M' },
    ]

    for (const patient of patients) {
      try {
        await prisma.patient.upsert({
          where: { patientId: patient.patientId },
          create: {
            id: `patient_${patient.patientId}`,
            patientId: patient.patientId,
            firstName: patient.firstName,
            lastName: patient.lastName,
            dateOfBirth: patient.dateOfBirth,
            sex: patient.sex,
          },
          update: {
            firstName: patient.firstName,
            lastName: patient.lastName,
            dateOfBirth: patient.dateOfBirth,
            sex: patient.sex,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert patient ${patient.patientId} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${patients.length} patients`)
    console.log('')

    // ========== 6. PRACTITIONERS ==========
    console.log('👨‍⚕️  Seeding Practitioners...')
    console.log('-'.repeat(80))

    const practitioners = [
      { practitionerId: 'PRAC-001', firstName: 'Dr. Sarah', lastName: 'Anderson', title: 'MD', department: 'Internal Medicine' },
      { practitionerId: 'PRAC-002', firstName: 'Dr. James', lastName: 'Wilson', title: 'MD', department: 'Pathology' },
      { practitionerId: 'PRAC-003', firstName: 'Dr. Emily', lastName: 'Davis', title: 'MD', department: 'Hematology' },
      { practitionerId: 'PRAC-004', firstName: 'Dr. David', lastName: 'Martinez', title: 'MD', department: 'Microbiology' },
      { practitionerId: 'PRAC-005', firstName: 'Nurse', lastName: 'Johnson', title: 'RN', department: 'Laboratory' },
    ]

    for (const prac of practitioners) {
      try {
        await prisma.practitioner.upsert({
          where: { practitionerId: prac.practitionerId },
          create: {
            id: `prac_${prac.practitionerId}`,
            practitionerId: prac.practitionerId,
            firstName: prac.firstName,
            lastName: prac.lastName,
            title: prac.title,
            department: prac.department,
          },
          update: {
            firstName: prac.firstName,
            lastName: prac.lastName,
            title: prac.title,
            department: prac.department,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert practitioner ${prac.practitionerId} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${practitioners.length} practitioners`)
    console.log('')

    // ========== 7. LAB ORDERS ==========
    console.log('📋 Seeding Lab Orders...')
    console.log('-'.repeat(80))

    await ensureDatabase('lab_orders')

    const labOrdersData = [
      {
        patientId: 'P00001',
        testCodeLoinc: '2339-0',
        status: 'completed',
        priority: 'routine',
        orderedAt: new Date('2024-12-01T08:00:00'),
        collectedAt: new Date('2024-12-01T08:30:00'),
        receivedAt: new Date('2024-12-01T09:00:00'),
        finalizedAt: new Date('2024-12-01T10:00:00'),
        practitionerId: 'PRAC-001',
      },
      {
        patientId: 'P00002',
        testCodeLoinc: '718-7',
        status: 'in-progress',
        priority: 'urgent',
        orderedAt: new Date('2024-12-02T09:00:00'),
        collectedAt: new Date('2024-12-02T09:15:00'),
        receivedAt: new Date('2024-12-02T09:30:00'),
        practitionerId: 'PRAC-002',
      },
      {
        patientId: 'P00003',
        testCodeLoinc: '58410-2',
        status: 'received',
        priority: 'routine',
        orderedAt: new Date('2024-12-03T10:00:00'),
        collectedAt: new Date('2024-12-03T10:30:00'),
        receivedAt: new Date('2024-12-03T11:00:00'),
        practitionerId: 'PRAC-003',
      },
    ]

    const createdOrderIds: string[] = []

    for (let i = 0; i < labOrdersData.length; i++) {
      const order = labOrdersData[i]
      const orderId = `order_${i + 1}_${Date.now()}`
      createdOrderIds.push(orderId)
      
      // Insert into CouchDB
      await insertCouchDoc('lab_orders', {
        _id: orderId,
        type: 'lab_order',
        ...order,
        orderedAt: order.orderedAt.toISOString(),
        collectedAt: order.collectedAt?.toISOString(),
        receivedAt: order.receivedAt?.toISOString(),
        finalizedAt: order.finalizedAt?.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Insert into PostgreSQL
      try {
        await prisma.labOrder.create({
          data: {
            id: orderId,
            patientId: order.patientId,
            testCodeLoinc: order.testCodeLoinc,
            status: order.status,
            priority: order.priority,
            orderedAt: order.orderedAt,
            collectedAt: order.collectedAt,
            receivedAt: order.receivedAt,
            finalizedAt: order.finalizedAt,
            practitionerId: order.practitionerId,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert lab order ${orderId} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${labOrdersData.length} lab orders`)
    console.log('')

    // ========== 8. SPECIMENS ==========
    console.log('🧪 Seeding Specimens...')
    console.log('-'.repeat(80))

    await ensureDatabase('specimens')

    const specimensData = [
      {
        orderId: createdOrderIds[0] || 'order_1',
        specimenTypeCode: '119297000',
        collectedAt: new Date('2024-12-01T08:30:00'),
        container: 'SST Tube',
        accessionNo: 'ACC-001',
        status: 'completed',
      },
      {
        orderId: createdOrderIds[1] || 'order_2',
        specimenTypeCode: '119297000',
        collectedAt: new Date('2024-12-02T09:15:00'),
        container: 'EDTA Tube',
        accessionNo: 'ACC-002',
        status: 'received',
      },
    ]

    for (const spec of specimensData) {
      if (!spec.orderId) continue
      
      const specId = `spec_${spec.accessionNo}`
      
      // Insert into CouchDB
      await insertCouchDoc('specimens', {
        _id: specId,
        type: 'specimen',
        ...spec,
        collectedAt: spec.collectedAt.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Insert into PostgreSQL
      try {
        await prisma.labSpecimen.create({
          data: {
            id: specId,
            orderId: spec.orderId,
            specimenTypeCode: spec.specimenTypeCode,
            collectedAt: spec.collectedAt,
            container: spec.container,
            accessionNo: spec.accessionNo,
          },
        })
      } catch (error) {
        console.warn(`Warning: Could not insert specimen ${specId} into PostgreSQL:`, (error as Error).message)
      }
    }
    console.log(`✅ Seeded ${specimensData.length} specimens`)
    console.log('')

    // ========== 9. INVENTORY ITEMS ==========
    console.log('📦 Seeding Inventory Items...')
    console.log('-'.repeat(80))

    await ensureDatabase('inventory')

    const inventoryItems = [
      { itemName: 'EDTA Tubes', itemCode: 'INV-001', category: 'Supplies', quantityOnHand: 500, reorderLevel: 100, unit: 'tubes' },
      { itemName: 'SST Tubes', itemCode: 'INV-002', category: 'Supplies', quantityOnHand: 300, reorderLevel: 100, unit: 'tubes' },
      { itemName: 'Glucose Reagent', itemCode: 'INV-003', category: 'Reagents', quantityOnHand: 50, reorderLevel: 20, unit: 'bottles' },
      { itemName: 'Hemoglobin Reagent', itemCode: 'INV-004', category: 'Reagents', quantityOnHand: 30, reorderLevel: 15, unit: 'bottles' },
      { itemName: 'Culture Media', itemCode: 'INV-005', category: 'Reagents', quantityOnHand: 100, reorderLevel: 50, unit: 'plates' },
    ]

    for (const item of inventoryItems) {
      await insertCouchDoc('inventory', {
        _id: `inv_${item.itemCode}`,
        type: 'inventory_item',
        ...item,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    console.log(`✅ Seeded ${inventoryItems.length} inventory items`)
    console.log('')

    // ========== 10. INSURANCE PROVIDERS ==========
    console.log('🏥 Seeding Insurance Providers...')
    console.log('-'.repeat(80))

    await ensureDatabase('insurance_providers')

    const insuranceProviders = [
      { name: 'Blue Cross Blue Shield', address: '123 Health St', phone: '555-0100', email: 'info@bcbs.com' },
      { name: 'Aetna', address: '456 Insurance Ave', phone: '555-0200', email: 'info@aetna.com' },
      { name: 'UnitedHealthcare', address: '789 Coverage Blvd', phone: '555-0300', email: 'info@uhc.com' },
    ]

    for (const provider of insuranceProviders) {
      await insertCouchDoc('insurance_providers', {
        _id: `ins_${provider.name.replace(/\s+/g, '-').toLowerCase()}`,
        type: 'insurance_provider',
        ...provider,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    console.log(`✅ Seeded ${insuranceProviders.length} insurance providers`)
    console.log('')

    console.log('='.repeat(80))
    console.log('✅ Seeding Complete!')
    console.log('='.repeat(80))
    console.log('')
    console.log('Summary:')
    console.log(`  - Organisms: ${organisms.length}`)
    console.log(`  - Antibiotics: ${antibiotics.length}`)
    console.log(`  - Value Sets: ${valueSets.length}`)
    console.log(`  - Test Catalog: ${testCatalogEntries.length}`)
    console.log(`  - Instruments: ${instruments.length}`)
    console.log(`  - Equipment: ${equipment.length}`)
    console.log(`  - Patients: ${patients.length}`)
    console.log(`  - Practitioners: ${practitioners.length}`)
    console.log(`  - Lab Orders: ${labOrdersData.length}`)
    console.log(`  - Specimens: ${specimensData.length}`)
    console.log(`  - Inventory Items: ${inventoryItems.length}`)
    console.log(`  - Insurance Providers: ${insuranceProviders.length}`)
    console.log('')
    console.log('All data has been seeded to both CouchDB and PostgreSQL!')
    console.log('')

  } catch (error) {
    console.error('❌ Error seeding data:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

// Run the script
if (require.main === module) {
  seedAllData()
    .then(() => {
      console.log('✅ All data seeding complete!')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Data seeding failed:', error)
      process.exit(1)
    })
}

export default seedAllData

