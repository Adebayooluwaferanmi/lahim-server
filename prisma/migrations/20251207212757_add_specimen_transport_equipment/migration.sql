-- CreateTable
CREATE TABLE "SpecimenTransport" (
    "id" TEXT NOT NULL,
    "specimenId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "transportType" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "temperature" DOUBLE PRECISION,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecimenTransport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "purchaseDate" TIMESTAMP(3),
    "warrantyExpiry" TIMESTAMP(3),
    "lastMaintenance" TIMESTAMP(3),
    "nextMaintenance" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentMaintenance" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "performedAt" TIMESTAMP(3),
    "performedBy" TEXT,
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpecimenTransport_specimenId_idx" ON "SpecimenTransport"("specimenId");

-- CreateIndex
CREATE INDEX "SpecimenTransport_orderId_idx" ON "SpecimenTransport"("orderId");

-- CreateIndex
CREATE INDEX "SpecimenTransport_status_idx" ON "SpecimenTransport"("status");

-- CreateIndex
CREATE INDEX "SpecimenTransport_scheduledAt_idx" ON "SpecimenTransport"("scheduledAt");

-- CreateIndex
CREATE INDEX "SpecimenTransport_transportType_idx" ON "SpecimenTransport"("transportType");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_serialNumber_key" ON "Equipment"("serialNumber");

-- CreateIndex
CREATE INDEX "Equipment_type_idx" ON "Equipment"("type");

-- CreateIndex
CREATE INDEX "Equipment_status_idx" ON "Equipment"("status");

-- CreateIndex
CREATE INDEX "Equipment_location_idx" ON "Equipment"("location");

-- CreateIndex
CREATE INDEX "Equipment_name_idx" ON "Equipment"("name");

-- CreateIndex
CREATE INDEX "EquipmentMaintenance_equipmentId_idx" ON "EquipmentMaintenance"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentMaintenance_scheduledAt_idx" ON "EquipmentMaintenance"("scheduledAt");

-- CreateIndex
CREATE INDEX "EquipmentMaintenance_type_idx" ON "EquipmentMaintenance"("type");

-- AddForeignKey
ALTER TABLE "SpecimenTransport" ADD CONSTRAINT "SpecimenTransport_specimenId_fkey" FOREIGN KEY ("specimenId") REFERENCES "LabSpecimen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecimenTransport" ADD CONSTRAINT "SpecimenTransport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LabOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentMaintenance" ADD CONSTRAINT "EquipmentMaintenance_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
