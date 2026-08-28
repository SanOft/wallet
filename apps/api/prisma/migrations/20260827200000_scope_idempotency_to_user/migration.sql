-- One namespace per client, instead of one namespace for everyone (P-8).
--
-- `idempotency_records.key` was the whole primary key, so a key is global: a
-- client that reuses a fixed value, or picks one deliberately, turns another
-- user's transfer into a 409. Nothing leaks — the service already refuses to
-- replay a record owned by someone else — but a payment somebody else can block
-- is a payment that does not happen.
--
-- Scoping the record alone would move the collision one layer down, because
-- `transfers.idempotencyKey` carried its own global unique constraint. Scoping
-- that needs an owner, and neither account column is one: for a P2P transfer
-- the initiator is the sender, for a demo top-up it is the *recipient*, since
-- the money leaves the treasury (§9.4). Hence `initiatedBy`.

-- Added nullable, backfilled from the account that identifies the initiator,
-- then made NOT NULL. Doing it in one statement would fail on every existing
-- row.
ALTER TABLE "transfers" ADD COLUMN "initiatedBy" UUID;

UPDATE "transfers" t
   SET "initiatedBy" = a."userId"
  FROM "accounts" a
 WHERE a."id" = CASE WHEN t."type" = 'TOPUP' THEN t."toAccountId" ELSE t."fromAccountId" END;

ALTER TABLE "transfers" ALTER COLUMN "initiatedBy" SET NOT NULL;

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_initiatedBy_fkey"
  FOREIGN KEY ("initiatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "transfers_idempotencyKey_key";
CREATE UNIQUE INDEX "transfers_initiatedBy_idempotencyKey_key"
  ON "transfers"("initiatedBy", "idempotencyKey");

-- The record's primary key becomes the pair. The old one was `key` alone.
ALTER TABLE "idempotency_records" DROP CONSTRAINT "idempotency_records_pkey";
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("userId", "key");
