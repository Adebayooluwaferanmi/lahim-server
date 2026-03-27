-- AlterTable
ALTER TABLE "LabOrder" ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "LabResult" ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "ExternalAccessNote" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAccessNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalAccessNote_tokenId_idx" ON "ExternalAccessNote"("tokenId");

-- CreateIndex
CREATE INDEX "ExternalAccessNote_patientId_idx" ON "ExternalAccessNote"("patientId");
