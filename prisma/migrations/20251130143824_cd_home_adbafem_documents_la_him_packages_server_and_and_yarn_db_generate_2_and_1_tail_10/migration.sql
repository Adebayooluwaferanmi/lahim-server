-- CreateTable
CREATE TABLE "LabOrder" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "testCodeLoinc" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "facilityId" TEXT,
    "practitionerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabSpecimen" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "specimenTypeCode" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "container" TEXT,
    "accessionNo" TEXT NOT NULL,
    "storageLocation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabSpecimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "specimenId" TEXT,
    "analyteCodeLoinc" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "valueNumber" DOUBLE PRECISION,
    "unitUcum" TEXT,
    "valueCode" TEXT,
    "valueText" TEXT,
    "codeSystem" TEXT,
    "refRangeLow" DOUBLE PRECISION,
    "refRangeHigh" DOUBLE PRECISION,
    "flags" TEXT[],
    "finalizedAt" TIMESTAMP(3),
    "performerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabMicroOrganism" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "organismCodeSnomed" TEXT NOT NULL,
    "organismDisplay" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabMicroOrganism_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabMicroSusceptibility" (
    "id" TEXT NOT NULL,
    "organismId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "antibioticCode" TEXT NOT NULL,
    "antibioticDisplay" TEXT NOT NULL,
    "method" TEXT,
    "micValueNumber" DOUBLE PRECISION,
    "micUnitUcum" TEXT,
    "interpretationCode" TEXT NOT NULL,
    "interpretationSystem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabMicroSusceptibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyCache" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemDisplay" TEXT NOT NULL,
    "codeSystem" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "locale" TEXT DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VocabularyCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QcResult" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT,
    "testCodeLoinc" TEXT NOT NULL,
    "qcMaterialLot" TEXT NOT NULL,
    "targetValue" DOUBLE PRECISION,
    "acceptableRangeLow" DOUBLE PRECISION,
    "acceptableRangeHigh" DOUBLE PRECISION,
    "actualValue" DOUBLE PRECISION NOT NULL,
    "unitUcum" TEXT,
    "qcRuleViolations" TEXT[],
    "status" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QcResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worklist" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "instrumentId" TEXT,
    "priority" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorklistItem" (
    "id" TEXT NOT NULL,
    "worklistId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "testCodeLoinc" TEXT NOT NULL,
    "assignedTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabOrder_patientId_idx" ON "LabOrder"("patientId");

-- CreateIndex
CREATE INDEX "LabOrder_status_idx" ON "LabOrder"("status");

-- CreateIndex
CREATE INDEX "LabOrder_orderedAt_idx" ON "LabOrder"("orderedAt");

-- CreateIndex
CREATE INDEX "LabOrder_testCodeLoinc_idx" ON "LabOrder"("testCodeLoinc");

-- CreateIndex
CREATE UNIQUE INDEX "LabSpecimen_accessionNo_key" ON "LabSpecimen"("accessionNo");

-- CreateIndex
CREATE INDEX "LabSpecimen_orderId_idx" ON "LabSpecimen"("orderId");

-- CreateIndex
CREATE INDEX "LabSpecimen_accessionNo_idx" ON "LabSpecimen"("accessionNo");

-- CreateIndex
CREATE INDEX "LabSpecimen_collectedAt_idx" ON "LabSpecimen"("collectedAt");

-- CreateIndex
CREATE INDEX "LabResult_orderId_idx" ON "LabResult"("orderId");

-- CreateIndex
CREATE INDEX "LabResult_specimenId_idx" ON "LabResult"("specimenId");

-- CreateIndex
CREATE INDEX "LabResult_analyteCodeLoinc_idx" ON "LabResult"("analyteCodeLoinc");

-- CreateIndex
CREATE INDEX "LabResult_finalizedAt_idx" ON "LabResult"("finalizedAt");

-- CreateIndex
CREATE INDEX "LabResult_resultType_idx" ON "LabResult"("resultType");

-- CreateIndex
CREATE INDEX "LabMicroOrganism_resultId_idx" ON "LabMicroOrganism"("resultId");

-- CreateIndex
CREATE INDEX "LabMicroOrganism_organismCodeSnomed_idx" ON "LabMicroOrganism"("organismCodeSnomed");

-- CreateIndex
CREATE INDEX "LabMicroSusceptibility_organismId_idx" ON "LabMicroSusceptibility"("organismId");

-- CreateIndex
CREATE INDEX "LabMicroSusceptibility_resultId_idx" ON "LabMicroSusceptibility"("resultId");

-- CreateIndex
CREATE INDEX "LabMicroSusceptibility_antibioticCode_idx" ON "LabMicroSusceptibility"("antibioticCode");

-- CreateIndex
CREATE INDEX "LabMicroSusceptibility_interpretationCode_idx" ON "LabMicroSusceptibility"("interpretationCode");

-- CreateIndex
CREATE INDEX "VocabularyCache_listId_idx" ON "VocabularyCache"("listId");

-- CreateIndex
CREATE INDEX "VocabularyCache_itemCode_idx" ON "VocabularyCache"("itemCode");

-- CreateIndex
CREATE INDEX "VocabularyCache_status_idx" ON "VocabularyCache"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyCache_listId_itemCode_key" ON "VocabularyCache"("listId", "itemCode");

-- CreateIndex
CREATE INDEX "QcResult_instrumentId_idx" ON "QcResult"("instrumentId");

-- CreateIndex
CREATE INDEX "QcResult_testCodeLoinc_idx" ON "QcResult"("testCodeLoinc");

-- CreateIndex
CREATE INDEX "QcResult_runAt_idx" ON "QcResult"("runAt");

-- CreateIndex
CREATE INDEX "QcResult_status_idx" ON "QcResult"("status");

-- CreateIndex
CREATE INDEX "Worklist_section_idx" ON "Worklist"("section");

-- CreateIndex
CREATE INDEX "Worklist_status_idx" ON "Worklist"("status");

-- CreateIndex
CREATE INDEX "Worklist_generatedAt_idx" ON "Worklist"("generatedAt");

-- CreateIndex
CREATE INDEX "WorklistItem_worklistId_idx" ON "WorklistItem"("worklistId");

-- CreateIndex
CREATE INDEX "WorklistItem_orderId_idx" ON "WorklistItem"("orderId");

-- CreateIndex
CREATE INDEX "WorklistItem_status_idx" ON "WorklistItem"("status");

-- AddForeignKey
ALTER TABLE "LabSpecimen" ADD CONSTRAINT "LabSpecimen_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LabOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LabOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_specimenId_fkey" FOREIGN KEY ("specimenId") REFERENCES "LabSpecimen"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabMicroOrganism" ADD CONSTRAINT "LabMicroOrganism_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "LabResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabMicroSusceptibility" ADD CONSTRAINT "LabMicroSusceptibility_organismId_fkey" FOREIGN KEY ("organismId") REFERENCES "LabMicroOrganism"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabMicroSusceptibility" ADD CONSTRAINT "LabMicroSusceptibility_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "LabResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorklistItem" ADD CONSTRAINT "WorklistItem_worklistId_fkey" FOREIGN KEY ("worklistId") REFERENCES "Worklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
