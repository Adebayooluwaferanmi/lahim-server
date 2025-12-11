-- AlterTable
ALTER TABLE "LabOrder" ADD COLUMN     "isPanel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "panelId" TEXT,
ALTER COLUMN "testCodeLoinc" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TestPanel" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "department" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestPanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestPanelParameter" (
    "id" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "parameterCode" TEXT NOT NULL,
    "parameterName" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "unit" TEXT,
    "refRangeLow" DOUBLE PRECISION,
    "refRangeHigh" DOUBLE PRECISION,
    "criticalLow" DOUBLE PRECISION,
    "criticalHigh" DOUBLE PRECISION,
    "defaultValue" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestPanelParameter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestPanel_code_key" ON "TestPanel"("code");

-- CreateIndex
CREATE INDEX "TestPanel_code_idx" ON "TestPanel"("code");

-- CreateIndex
CREATE INDEX "TestPanel_active_idx" ON "TestPanel"("active");

-- CreateIndex
CREATE INDEX "TestPanel_department_idx" ON "TestPanel"("department");

-- CreateIndex
CREATE INDEX "TestPanelParameter_panelId_idx" ON "TestPanelParameter"("panelId");

-- CreateIndex
CREATE INDEX "TestPanelParameter_parameterCode_idx" ON "TestPanelParameter"("parameterCode");

-- CreateIndex
CREATE UNIQUE INDEX "TestPanelParameter_panelId_parameterCode_key" ON "TestPanelParameter"("panelId", "parameterCode");

-- CreateIndex
CREATE INDEX "LabOrder_panelId_idx" ON "LabOrder"("panelId");

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "TestPanel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPanelParameter" ADD CONSTRAINT "TestPanelParameter_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "TestPanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPanelParameter" ADD CONSTRAINT "TestPanelParameter_parameterCode_fkey" FOREIGN KEY ("parameterCode") REFERENCES "TestCatalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
