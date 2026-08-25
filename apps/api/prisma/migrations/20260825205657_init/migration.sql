-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'TREASURY');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransferType" AS ENUM ('P2P', 'TOPUP');

-- CreateEnum
CREATE TYPE "TransferChannel" AS ENUM ('WEB', 'USSD');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "pinHash" TEXT,
    "pinLockedUntil" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "type" "AccountType" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "fromAccountId" UUID NOT NULL,
    "toAccountId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "type" "TransferType" NOT NULL DEFAULT 'P2P',
    "channel" "TransferChannel" NOT NULL DEFAULT 'WEB',
    "idempotencyKey" TEXT NOT NULL,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_userId_currency_key" ON "accounts"("userId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_idempotencyKey_key" ON "transfers"("idempotencyKey");

-- CreateIndex
CREATE INDEX "transfers_fromAccountId_createdAt_idx" ON "transfers"("fromAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "transfers_toAccountId_createdAt_idx" ON "transfers"("toAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_createdAt_idx" ON "ledger_entries"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_transferId_idx" ON "ledger_entries"("transferId");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "auth_attempts_userId_createdAt_idx" ON "auth_attempts"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_attempts" ADD CONSTRAINT "auth_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Invariants (spec 9.5). Added by hand: Prisma has no schema syntax for CHECK.
--
-- These live in the database rather than only in the service because a service
-- is one bug away from violating them, and a violated ledger invariant is not
-- recoverable from logs.
-- ============================================================================

-- I-5: a USER account can never go negative. TREASURY is the mint (9.4) and is
-- the single exception; scoping the exemption to the type is what keeps a bug
-- in transfer code from quietly overdrawing a customer.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balance_non_negative"
  CHECK ("balance" >= 0 OR "type" = 'TREASURY');

-- Currency is an ISO 4217 alpha code (9.3).
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- FR-4.7: a transfer moves a strictly positive amount. Direction is expressed
-- by the ledger pair, never by the sign of this column.
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive"
  CHECK ("amount" > 0);

-- A completion timestamp and a COMPLETED status are the same fact; allowing
-- them to disagree would make history lie about when money moved (FR-4.8).
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_completed_at_matches_status"
  CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));

-- A zero entry carries no information and would let a transfer satisfy
-- "two rows summing to zero" (I-2) while moving nothing at all.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_nonzero"
  CHECK ("amount" <> 0);

-- A stored response must be a real HTTP status; replaying garbage is worse
-- than re-executing (FR-4.4).
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_status_code_range"
  CHECK ("statusCode" BETWEEN 100 AND 599);

-- Phone is the account identity (FR-1.1). Zod validates it at every entry
-- point; this is the second lock, so a future code path that forgets cannot
-- create an unreachable account.
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_e164"
  CHECK ("phone" ~ '^\+[1-9][0-9]{1,14}$');

-- ============================================================================
-- I-3: the ledger is append-only.
--
-- The repository API exposes no update or delete, but "the code has no method
-- for it" protects only the code that goes through the repository. This makes
-- the guarantee hold for psql, for a migration, and for a future service that
-- has not been written yet.
-- ============================================================================

CREATE OR REPLACE FUNCTION "ledger_entries_reject_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (invariant I-3): % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_no_update"
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_reject_mutation"();

CREATE TRIGGER "ledger_entries_no_delete"
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_reject_mutation"();
