-- CreateTable
CREATE TABLE "ExternalAccessRequest" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestedBy" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "tokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalAccessToken" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "recipientEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalAccessRequest_patientId_idx" ON "ExternalAccessRequest"("patientId");

-- CreateIndex
CREATE INDEX "ExternalAccessRequest_status_idx" ON "ExternalAccessRequest"("status");

-- CreateIndex
CREATE INDEX "ExternalAccessRequest_recipientEmail_idx" ON "ExternalAccessRequest"("recipientEmail");

-- CreateIndex
CREATE INDEX "ExternalAccessRequest_createdAt_idx" ON "ExternalAccessRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAccessToken_requestId_key" ON "ExternalAccessToken"("requestId");

-- CreateIndex
CREATE INDEX "ExternalAccessToken_tokenHash_idx" ON "ExternalAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ExternalAccessToken_patientId_idx" ON "ExternalAccessToken"("patientId");

-- CreateIndex
CREATE INDEX "ExternalAccessToken_expiresAt_idx" ON "ExternalAccessToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ExternalAccessRequest" ADD CONSTRAINT "ExternalAccessRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("patientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAccessToken" ADD CONSTRAINT "ExternalAccessToken_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ExternalAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAccessToken" ADD CONSTRAINT "ExternalAccessToken_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("patientId") ON DELETE CASCADE ON UPDATE CASCADE;
