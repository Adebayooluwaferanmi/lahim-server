-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "section" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCatalog" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_serialNumber_key" ON "Instrument"("serialNumber");

-- CreateIndex
CREATE INDEX "Instrument_status_idx" ON "Instrument"("status");

-- CreateIndex
CREATE INDEX "Instrument_section_idx" ON "Instrument"("section");

-- CreateIndex
CREATE INDEX "Instrument_name_idx" ON "Instrument"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TestCatalog_code_key" ON "TestCatalog"("code");

-- CreateIndex
CREATE INDEX "TestCatalog_code_idx" ON "TestCatalog"("code");

-- CreateIndex
CREATE INDEX "TestCatalog_active_idx" ON "TestCatalog"("active");

-- CreateIndex
CREATE INDEX "TestCatalog_department_idx" ON "TestCatalog"("department");

-- CreateIndex
CREATE INDEX "Worklist_instrumentId_idx" ON "Worklist"("instrumentId");

-- CreateIndex
CREATE INDEX "WorklistItem_testCodeLoinc_idx" ON "WorklistItem"("testCodeLoinc");

-- Populate TestCatalog with existing test codes from LabOrder, LabResult, QcResult, and WorklistItem
-- This ensures all existing test codes exist in TestCatalog before adding foreign key constraints
INSERT INTO "TestCatalog" ("id", "code", "name", "active", "createdAt", "updatedAt")
SELECT DISTINCT
    'test_catalog_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16) || '_' || extract(epoch from now())::bigint::text || '_' || row_number() OVER () as id,
    test_code as code,
    test_code as name,
    true as active,
    CURRENT_TIMESTAMP as "createdAt",
    CURRENT_TIMESTAMP as "updatedAt"
FROM (
    SELECT DISTINCT "testCodeLoinc" as test_code FROM "LabOrder" WHERE "testCodeLoinc" IS NOT NULL AND "testCodeLoinc" != ''
    UNION
    SELECT DISTINCT "analyteCodeLoinc" as test_code FROM "LabResult" WHERE "analyteCodeLoinc" IS NOT NULL AND "analyteCodeLoinc" != ''
    UNION
    SELECT DISTINCT "testCodeLoinc" as test_code FROM "QcResult" WHERE "testCodeLoinc" IS NOT NULL AND "testCodeLoinc" != ''
    UNION
    SELECT DISTINCT "testCodeLoinc" as test_code FROM "WorklistItem" WHERE "testCodeLoinc" IS NOT NULL AND "testCodeLoinc" != ''
) all_test_codes
WHERE NOT EXISTS (
    SELECT 1 FROM "TestCatalog" WHERE "code" = all_test_codes.test_code
)
ON CONFLICT ("code") DO NOTHING;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_testCodeLoinc_fkey" FOREIGN KEY ("testCodeLoinc") REFERENCES "TestCatalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_analyteCodeLoinc_fkey" FOREIGN KEY ("analyteCodeLoinc") REFERENCES "TestCatalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcResult" ADD CONSTRAINT "QcResult_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcResult" ADD CONSTRAINT "QcResult_testCodeLoinc_fkey" FOREIGN KEY ("testCodeLoinc") REFERENCES "TestCatalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worklist" ADD CONSTRAINT "Worklist_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorklistItem" ADD CONSTRAINT "WorklistItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LabOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorklistItem" ADD CONSTRAINT "WorklistItem_testCodeLoinc_fkey" FOREIGN KEY ("testCodeLoinc") REFERENCES "TestCatalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
