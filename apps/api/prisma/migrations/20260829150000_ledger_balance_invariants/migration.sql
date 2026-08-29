-- Two invariants the database stated in prose and enforced nowhere (P-2, P-21).
--
-- `accounts.balance` is a cached answer; the journal is the truth. Nothing
-- compared them except `reconcile`, which runs daily (§20.4) — so a drift at
-- 09:00 was invisible until the next morning, and by then the transfers built
-- on the wrong number had already happened. And `balanceAfter`, which §9.2
-- sells as making an audit O(1), was validated by nothing at all: not the
-- CHECKs, not `assert_transfer_balanced`, not `reconcile`. An audit column
-- nobody checks is worse than no column, because a reconciliation built on it
-- reads from the source it is meant to police.
--
-- Both are now refused at COMMIT, in the deferred trigger that already holds
-- I-1, I-2 and I-6. A day of wrong balances becomes a transaction that cannot
-- commit.

-- ---------------------------------------------------------------------------
-- A total order per account, which the check needs and `createdAt` cannot give
-- ---------------------------------------------------------------------------
--
-- `createdAt` defaults to the transaction timestamp, so every entry written by
-- one transaction shares it, and "the previous entry for this account" is not
-- well defined. A self-transfer is not forbidden anywhere, which is exactly
-- the case that would tie. A sequence is assigned per INSERT and settles it.

ALTER TABLE "ledger_entries" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "ledger_entries_seq_key" ON "ledger_entries"("seq");

-- The lookup the check performs: newest entry for one account, O(1).
CREATE INDEX "ledger_entries_account_seq_idx" ON "ledger_entries"("accountId", "seq" DESC);

-- ---------------------------------------------------------------------------
-- One-time repair, so the checks below can be true of existing rows
-- ---------------------------------------------------------------------------
--
-- `balanceAfter` is *derived*: the amounts are authoritative and this column is
-- their running total. Recomputing it is restoring a cache, not rewriting
-- history — no `amount` is touched, and no entry is added or removed.
--
-- It needs the append-only trigger suspended, which deserves saying out loud
-- rather than hiding: `ledger_entries` rejects UPDATE precisely so that nothing
-- can do this at runtime. A migration running as the schema owner is the one
-- context where it is allowed, it happens once, and after it the trigger added
-- below makes the column impossible to drift again.
--
-- Both statements report what they changed. A repair that silently rewrites
-- money columns is not something anybody should discover later from a diff.

DO $$
DECLARE repaired_entries INT; repaired_accounts INT;
BEGIN
  SET LOCAL session_replication_role = 'replica';

  WITH ordered AS (
    SELECT "id",
           SUM("amount") OVER (PARTITION BY "accountId" ORDER BY "seq"
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
      FROM "ledger_entries"
  )
  UPDATE "ledger_entries" le
     SET "balanceAfter" = o.running
    FROM ordered o
   WHERE o."id" = le."id" AND le."balanceAfter" <> o.running;
  GET DIAGNOSTICS repaired_entries = ROW_COUNT;

  UPDATE "accounts" a
     SET "balance" = COALESCE((SELECT SUM(le."amount") FROM "ledger_entries" le
                                WHERE le."accountId" = a."id"), 0)
   WHERE a."balance" <> COALESCE((SELECT SUM(le."amount") FROM "ledger_entries" le
                                   WHERE le."accountId" = a."id"), 0);
  GET DIAGNOSTICS repaired_accounts = ROW_COUNT;

  IF repaired_entries > 0 OR repaired_accounts > 0 THEN
    RAISE NOTICE 'ledger repair: rebuilt balanceAfter on % entries, corrected balance on % accounts',
      repaired_entries, repaired_accounts;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- I-4 and the balanceAfter chain, at COMMIT
-- ---------------------------------------------------------------------------
--
-- Added to `assert_transfer_balanced` rather than to a trigger of their own, so
-- that a transfer is checked as one thing: the existing body already holds the
-- pair, the amount and the parties, and these two complete the picture.
--
-- Both are O(1). The chain is verified only for the entries this transfer
-- wrote, each against its own predecessor — which makes the whole chain correct
-- by induction, because every entry is checked when it is written. Summing the
-- account's history instead would be correct too, and would cost the treasury
-- an ever-growing aggregate on every demo top-up.

CREATE OR REPLACE FUNCTION "assert_transfer_balanced"(transfer_id UUID)
RETURNS void AS $$
DECLARE
  t RECORD; entry_count INT; entry_sum BIGINT; stranger_count INT;
  e RECORD; previous BIGINT; expected BIGINT;
  acct UUID; snapshot BIGINT; newest BIGINT;
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
    FROM "ledger_entries" e2
    WHERE e2."transferId" = transfer_id
      AND e2."accountId" NOT IN (t."fromAccountId", t."toAccountId");
  IF stranger_count > 0 THEN
    RAISE EXCEPTION 'transfer % has % ledger entries on accounts that are not parties to it',
      transfer_id, stranger_count USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The pair must move exactly the amount the transfer claims, in the stated
  -- direction. Without this, two entries of ±1 satisfy every rule above while
  -- the transfer says 1 000 000.
  IF NOT EXISTS (
    SELECT 1 FROM "ledger_entries" e2
     WHERE e2."transferId" = transfer_id
       AND e2."accountId" = t."fromAccountId" AND e2."amount" = -t."amount"
  ) OR NOT EXISTS (
    SELECT 1 FROM "ledger_entries" e2
     WHERE e2."transferId" = transfer_id
       AND e2."accountId" = t."toAccountId" AND e2."amount" = t."amount"
  ) THEN
    RAISE EXCEPTION 'ledger entries for transfer % do not match its amount of %',
      transfer_id, t."amount" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- P-21: every entry's balanceAfter is its account's running total.
  FOR e IN
    SELECT "id", "accountId", "amount", "balanceAfter", "seq"
      FROM "ledger_entries" WHERE "transferId" = transfer_id
  LOOP
    SELECT le."balanceAfter" INTO previous
      FROM "ledger_entries" le
     WHERE le."accountId" = e."accountId" AND le."seq" < e."seq"
     ORDER BY le."seq" DESC
     LIMIT 1;

    expected := COALESCE(previous, 0) + e."amount";

    IF e."balanceAfter" <> expected THEN
      RAISE EXCEPTION
        'invariant P-21: ledger entry % claims balanceAfter % on account %, but its predecessor plus its own amount is %',
        e."id", e."balanceAfter", e."accountId", expected
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;

  -- I-4: the snapshot agrees with the journal, now rather than tomorrow.
  --
  -- Compared against the newest entry's balanceAfter rather than against
  -- SUM(amount): the loop above has just established that the two are the same
  -- number, and this way the treasury does not pay for an aggregate over its
  -- whole history on every top-up.
  FOREACH acct IN ARRAY ARRAY[t."fromAccountId", t."toAccountId"] LOOP
    SELECT le."balanceAfter" INTO newest
      FROM "ledger_entries" le
     WHERE le."accountId" = acct
     ORDER BY le."seq" DESC
     LIMIT 1;

    SELECT a."balance" INTO snapshot FROM "accounts" a WHERE a."id" = acct;

    IF snapshot IS DISTINCT FROM COALESCE(newest, 0) THEN
      RAISE EXCEPTION
        'invariant I-4: account % holds balance % but its journal ends at %',
        acct, snapshot, COALESCE(newest, 0)
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
