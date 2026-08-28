-- CreateTable
CREATE TABLE "rates_snapshots" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rates_snapshots_pkey" PRIMARY KEY ("id")
);
