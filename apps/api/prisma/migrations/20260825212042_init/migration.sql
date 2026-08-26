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
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "type" "AccountType" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
-- Invariants (spec §9.5), added by hand because Prisma has no syntax for them.
--
-- Scope, stated honestly: everything below holds against ordinary DML from any
-- client. None of it survives an actor with table ownership — TRUNCATE is
-- guarded, but DISABLE TRIGGER, CREATE OR REPLACE on these functions, and
-- session_replication_role = replica all remain available to the owner, and the
-- application currently connects as one. Running the API under a role that owns
-- nothing is deployment work (T-2.6) and is tracked as such; until then the
-- guarantee is "a bug in service code cannot corrupt the ledger", not "nothing
-- can".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Single-row constraints
-- ---------------------------------------------------------------------------

-- I-5: a USER account can never go negative. TREASURY is the mint (§9.4).
-- The exemption is anchored below by making `type` immutable and tying it to
-- the SYSTEM user; on its own, a CHECK on a mutable column is a permit an
-- attacker can sign for themselves.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balance_non_negative"
  CHECK ("balance" >= 0 OR "type" = 'TREASURY');

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- FR-4.7: a transfer moves a strictly positive amount, and never to itself.
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_not_self"
  CHECK ("fromAccountId" <> "toAccountId");

-- A completion timestamp and a COMPLETED status are the same fact (FR-4.8).
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_completed_at_matches_status"
  CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));

-- A zero entry would let a transfer satisfy "two rows summing to zero" (I-2)
-- while moving nothing at all.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_nonzero"
  CHECK ("amount" <> 0);

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_status_code_range"
  CHECK ("statusCode" BETWEEN 100 AND 599);

-- Phone is the account identity (FR-1.1). Zod validates it at every entry
-- point; this is the second lock.
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_e164"
  CHECK ("phone" ~ '^\+[1-9][0-9]{1,14}$');

-- §4: the SYSTEM user never signs in. Pinning the sentinel here makes that
-- structural rather than a promise about login code that is not written yet.
ALTER TABLE "users"
  ADD CONSTRAINT "users_system_cannot_authenticate"
  CHECK ("role" <> 'SYSTEM' OR "passwordHash" = '!system-account-cannot-authenticate!');

-- §9.4: exactly one treasury.
CREATE UNIQUE INDEX "accounts_single_treasury"
  ON "accounts" ("type") WHERE "type" = 'TREASURY';

-- ---------------------------------------------------------------------------
-- I-3: the ledger is append-only
-- ---------------------------------------------------------------------------

CREATE FUNCTION "ledger_entries_reject_mutation"()
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

-- Row triggers never fire for TRUNCATE, so the two above would let the entire
-- journal be erased in one statement. This is the statement-level guard.
CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger_entries_reject_mutation"();

-- ---------------------------------------------------------------------------
-- Account type is the anchor of the treasury exemption, so it cannot move
-- ---------------------------------------------------------------------------

CREATE FUNCTION "accounts_guard_type"()
RETURNS trigger AS $$
DECLARE owner_role "UserRole";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."type" IS DISTINCT FROM OLD."type" THEN
    RAISE EXCEPTION 'accounts.type is immutable: changing it would move the I-5 exemption'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."type" = 'TREASURY' THEN
    SELECT "role" INTO owner_role FROM "users" WHERE "id" = NEW."userId";
    IF owner_role IS DISTINCT FROM 'SYSTEM' THEN
      RAISE EXCEPTION 'a TREASURY account must belong to the SYSTEM user (spec 9.4)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "accounts_type_guard"
  BEFORE INSERT OR UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION "accounts_guard_type"();

-- ---------------------------------------------------------------------------
-- Transfer parties must make arithmetic sense
-- ---------------------------------------------------------------------------

CREATE FUNCTION "transfers_guard_parties"()
RETURNS trigger AS $$
DECLARE from_currency TEXT; to_currency TEXT; from_type "AccountType";
BEGIN
  SELECT "currency", "type" INTO from_currency, from_type
    FROM "accounts" WHERE "id" = NEW."fromAccountId";
  SELECT "currency" INTO to_currency
    FROM "accounts" WHERE "id" = NEW."toAccountId";

  -- One amount column and no FX rate: a cross-currency transfer is not a
  -- rounding question, it is arithmetically meaningless (§9.3).
  IF from_currency IS DISTINCT FROM to_currency THEN
    RAISE EXCEPTION 'cross-currency transfer is not supported (spec 9.3)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- §9.4: demo money is issued by the mint, not conjured by a user account.
  IF NEW."type" = 'TOPUP' AND from_type IS DISTINCT FROM 'TREASURY' THEN
    RAISE EXCEPTION 'a TOPUP must originate from the treasury (spec 9.4)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transfers_parties_guard"
  BEFORE INSERT OR UPDATE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION "transfers_guard_parties"();

-- ---------------------------------------------------------------------------
-- I-1, I-2, I-6: the multi-row invariants
--
-- These cannot be CHECK constraints — they compare a row to an aggregate over
-- another table. They are DEFERRABLE INITIALLY DEFERRED constraint triggers,
-- checked at COMMIT, because a correct writer inserts the entries and flips the
-- status inside one transaction and would fail any check applied per statement.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "assert_transfer_balanced"(transfer_id UUID)
RETURNS void AS $$
DECLARE t RECORD; entry_count INT; entry_sum BIGINT; stranger_count INT;
BEGIN
  SELECT * INTO t FROM "transfers" WHERE "id" = transfer_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*), COALESCE(sum("amount"), 0)
    INTO entry_count, entry_sum
    FROM "ledger_entries" WHERE "transferId" = transfer_id;

  IF t."status" <> 'COMPLETED' THEN
    -- I-6: entries exist only on the success path.
    IF entry_count > 0 THEN
      RAISE EXCEPTION 'invariant I-6: transfer % is % but carries % ledger entries',
        transfer_id, t."status", entry_count USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN;
  END IF;

  -- I-2: exactly two entries.
  IF entry_count <> 2 THEN
    RAISE EXCEPTION 'invariant I-2: COMPLETED transfer % has % ledger entries, expected 2',
      transfer_id, entry_count USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- I-1: the pair sums to zero, which is what makes the global sum zero.
  IF entry_sum <> 0 THEN
    RAISE EXCEPTION 'invariant I-1: ledger entries for transfer % sum to %, expected 0',
      transfer_id, entry_sum USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- An entry may only name a party to its own transfer; otherwise money can be
  -- credited to an arbitrary account under cover of an unrelated transfer.
  SELECT count(*) INTO stranger_count
    FROM "ledger_entries" e
    WHERE e."transferId" = transfer_id
      AND e."accountId" NOT IN (t."fromAccountId", t."toAccountId");
  IF stranger_count > 0 THEN
    RAISE EXCEPTION 'transfer % has % ledger entries on accounts that are not parties to it',
      transfer_id, stranger_count USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The pair must move exactly the amount the transfer claims, in the stated
  -- direction. Without this, two entries of ±1 satisfy every rule above while
  -- the transfer says 1 000 000.
  IF NOT EXISTS (
    SELECT 1 FROM "ledger_entries" e
     WHERE e."transferId" = transfer_id
       AND e."accountId" = t."fromAccountId" AND e."amount" = -t."amount"
  ) OR NOT EXISTS (
    SELECT 1 FROM "ledger_entries" e
     WHERE e."transferId" = transfer_id
       AND e."accountId" = t."toAccountId" AND e."amount" = t."amount"
  ) THEN
    RAISE EXCEPTION 'ledger entries for transfer % do not match its amount of %',
      transfer_id, t."amount" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "ledger_entries_assert_balanced"()
RETURNS trigger AS $$
BEGIN
  PERFORM "assert_transfer_balanced"(NEW."transferId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "transfers_assert_balanced"()
RETURNS trigger AS $$
BEGIN
  PERFORM "assert_transfer_balanced"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_assert_balanced"();

CREATE CONSTRAINT TRIGGER "transfers_balanced"
  AFTER INSERT OR UPDATE ON "transfers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "transfers_assert_balanced"();
