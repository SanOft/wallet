-- The role the API connects as in production (P-4).
--
-- Run once, as the database owner, against the production database. Replace
-- __PASSWORD__ with a generated secret first; `DATABASE_URL` then names this
-- role instead of the owner.
--
-- Why this exists. ADR-0001 puts the ledger's invariants in the database so
-- that a bug in service code cannot corrupt them. That argument holds only
-- against ordinary DML. The owner can run `ALTER TABLE ledger_entries DISABLE
-- TRIGGER USER`, replace `assert_transfer_balanced` with a function that
-- returns without checking, or set `session_replication_role = replica` — and
-- the application process, which is the most likely thing to be compromised,
-- has been connecting as the owner. The migration header is careful to claim
-- only that a bug in service code cannot corrupt the ledger. This is what makes
-- the stronger claim true.
--
-- The role owns nothing. Migrations keep running as the owner
-- (`DATABASE_URL_UNPOOLED`), because they must create and alter; the running
-- service does neither.
--
-- Idempotent: safe to run again after a schema change, and it must be run
-- again if one adds a table, though `ALTER DEFAULT PRIVILEGES` below is there
-- so that is a belt rather than the only strap.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallet_runtime') THEN
    CREATE ROLE wallet_runtime LOGIN PASSWORD '__PASSWORD__';
  END IF;
END
$$;

-- Set unconditionally, outside the block above.
--
-- The `IF NOT EXISTS` guard makes creation idempotent and would otherwise make
-- the *password* conditional with it: run this file a second time with a new
-- secret and the role would keep the old one, silently. That is also how this
-- file is rotated — change the secret, run it again.
ALTER ROLE wallet_runtime PASSWORD '__PASSWORD__';

-- Stated rather than assumed. `CREATE ROLE` defaults to all of these already;
-- writing them down means a role that drifted — granted `CREATEROLE` by someone
-- debugging at 2am — is put back by re-running this file.
ALTER ROLE wallet_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO wallet_runtime;

-- Reads and writes rows. Never changes what a row is allowed to be.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO wallet_runtime;

-- `DELETE` only where the application actually deletes, which is the expiry
-- sweep in `TransferService`: an idempotency record past its 24 hours, and the
-- FAILED transfer that shared its key. Deliberately not granted on
-- `ledger_entries`, `accounts` or `users` — the append-only trigger already
-- refuses the first, and this means the other two cannot be removed even by a
-- process that has been taken over.
GRANT DELETE ON TABLE "idempotency_records", "transfers" TO wallet_runtime;

-- `ledger_entries.seq` is a BIGSERIAL; without this every insert fails.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wallet_runtime;

-- So a table added by a later migration is reachable without anyone
-- remembering to come back here. Applies to objects created by whoever runs
-- this file, which is the owner that runs the migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wallet_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wallet_runtime;
