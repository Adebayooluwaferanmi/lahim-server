-- CreateTable
CREATE TABLE "CriticalValue" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "testCodeLoinc" TEXT NOT NULL,
    "testName" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "unitUcum" TEXT,
    "referenceRangeLow" DOUBLE PRECISION,
    "referenceRangeHigh" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detectedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedBy" TEXT,
    "acknowledgedOn" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CriticalValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "sex" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Practitioner" (
    "id" TEXT NOT NULL,
    "practitionerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "department" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CriticalValue_resultId_idx" ON "CriticalValue"("resultId");

-- CreateIndex
CREATE INDEX "CriticalValue_patientId_idx" ON "CriticalValue"("patientId");

-- CreateIndex
CREATE INDEX "CriticalValue_status_idx" ON "CriticalValue"("status");

-- CreateIndex
CREATE INDEX "CriticalValue_detectedOn_idx" ON "CriticalValue"("detectedOn");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientId_key" ON "Patient"("patientId");

-- CreateIndex
CREATE INDEX "Patient_patientId_idx" ON "Patient"("patientId");

-- CreateIndex
CREATE INDEX "Patient_lastName_firstName_idx" ON "Patient"("lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_practitionerId_key" ON "Practitioner"("practitionerId");

-- CreateIndex
CREATE INDEX "Practitioner_practitionerId_idx" ON "Practitioner"("practitionerId");

-- CreateIndex
CREATE INDEX "Practitioner_lastName_firstName_idx" ON "Practitioner"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "LabOrder_practitionerId_idx" ON "LabOrder"("practitionerId");

-- CreateIndex
CREATE INDEX "LabResult_performerId_idx" ON "LabResult"("performerId");

-- CreateIndex
CREATE INDEX "QcResult_performerId_idx" ON "QcResult"("performerId");

-- CreateIndex
CREATE INDEX "WorklistItem_assignedTo_idx" ON "WorklistItem"("assignedTo");

-- Populate Patient table with existing patientIds from LabOrder
-- This ensures all existing patientIds exist in Patient before adding foreign key constraints
INSERT INTO "Patient" ("id", "patientId", "createdAt", "updatedAt")
SELECT DISTINCT
    'patient_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16) || '_' || extract(epoch from now())::bigint::text || '_' || row_number() OVER () as id,
    patient_id as "patientId",
    CURRENT_TIMESTAMP as "createdAt",
    CURRENT_TIMESTAMP as "updatedAt"
FROM (
    SELECT DISTINCT "patientId" as patient_id FROM "LabOrder" WHERE "patientId" IS NOT NULL AND "patientId" != ''
) all_patient_ids
WHERE NOT EXISTS (
    SELECT 1 FROM "Patient" WHERE "patientId" = all_patient_ids.patient_id
)
ON CONFLICT ("patientId") DO NOTHING;

-- Populate Practitioner table with existing practitionerIds from LabOrder, LabResult, QcResult, and WorklistItem
-- This ensures all existing practitionerIds exist in Practitioner before adding foreign key constraints
INSERT INTO "Practitioner" ("id", "practitionerId", "createdAt", "updatedAt")
SELECT DISTINCT
    'practitioner_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16) || '_' || extract(epoch from now())::bigint::text || '_' || row_number() OVER () as id,
    practitioner_id as "practitionerId",
    CURRENT_TIMESTAMP as "createdAt",
    CURRENT_TIMESTAMP as "updatedAt"
FROM (
    SELECT DISTINCT "practitionerId" as practitioner_id FROM "LabOrder" WHERE "practitionerId" IS NOT NULL AND "practitionerId" != ''
    UNION
    SELECT DISTINCT "performerId" as practitioner_id FROM "LabResult" WHERE "performerId" IS NOT NULL AND "performerId" != ''
    UNION
    SELECT DISTINCT "performerId" as practitioner_id FROM "QcResult" WHERE "performerId" IS NOT NULL AND "performerId" != ''
    UNION
    SELECT DISTINCT "assignedTo" as practitioner_id FROM "WorklistItem" WHERE "assignedTo" IS NOT NULL AND "assignedTo" != ''
) all_practitioner_ids
WHERE NOT EXISTS (
    SELECT 1 FROM "Practitioner" WHERE "practitionerId" = all_practitioner_ids.practitioner_id
)
ON CONFLICT ("practitionerId") DO NOTHING;

-- AddForeignKey
ALTER TABLE "CriticalValue" ADD CONSTRAINT "CriticalValue_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "LabResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriticalValue" ADD CONSTRAINT "CriticalValue_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("patientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("practitionerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "Practitioner"("practitionerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QcResult" ADD CONSTRAINT "QcResult_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "Practitioner"("practitionerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorklistItem" ADD CONSTRAINT "WorklistItem_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "Practitioner"("practitionerId") ON DELETE SET NULL ON UPDATE CASCADE;
