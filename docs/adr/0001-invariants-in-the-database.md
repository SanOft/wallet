# ADR-0001 — The ledger's invariants live in the database, not in the service

**Status:** Accepted — day 2
**Relates to:** spec §9.2 (I-1…I-6), §10, `apps/api/prisma/migrations/*/migration.sql`

## Context

A wallet's only real promise is that money is neither created nor destroyed. The
spec states six invariants (I-1…I-6) and the usual way to hold them is inside
the service that writes: check the balance, insert two rows, update two
accounts, all in one transaction, with the rules expressed as TypeScript.

That works exactly as long as every writer is that service. It stops working the
moment there is a second writer — a migration script, a support tool, a
one-off `UPDATE` typed at 2am to fix a stuck transfer, a future USSD adapter, or
the same service with a bug in a branch nobody tested. Each of those is a
realistic event, and each of them silently breaks a guarantee the product is
sold on.

The failure is also unusually hard to detect after the fact. A corrupted ledger
still returns plausible numbers; nothing throws.

## Decision

The invariants are enforced by PostgreSQL, as constraints and triggers, and the
service is treated as one client among several.

- Ledger rows are append-only: triggers reject `UPDATE`, `DELETE` and
  `TRUNCATE` on `ledger_entries` outright. There is no code path, in this
  service or any other, that can rewrite history.
- A deferred `CONSTRAINT TRIGGER` checks at COMMIT that a `COMPLETED` transfer
  produced exactly two entries, on the two accounts party to that transfer, with
  amounts matching the transfer's own amount and direction, summing to zero —
  and that a non-`COMPLETED` transfer produced none.
- Nine `CHECK` constraints hold the smaller rules: non-negative user balances, a
  non-zero ledger amount, the treasury being the only account allowed to go
  negative, an account's type being immutable.
- A partial unique index permits exactly one treasury account.

`DEFERRABLE INITIALLY DEFERRED` is what makes the multi-row rule expressible at
all: the two entries cannot both exist until the transaction is complete, so the
check has to run at COMMIT rather than per statement.

## Consequences

A bug in application code cannot corrupt the ledger. That claim is testable, and
it is tested: the suite writes deliberately unbalanced pairs and asserts the
database refuses them.

The costs are real:

- Some rules exist in two places — the service returns a friendly
  `INSUFFICIENT_FUNDS` before the CHECK would have fired. The database is the
  authority; the service copy exists for the error message.
- Constraint violations arrive as Postgres error codes (`23514`, `23505`) that
  the repository has to translate.
- The rules are in SQL, in a migration, where a TypeScript developer will not
  think to look. This is mitigated by the migration carrying a header that says
  what it enforces and why — and that header states the limit honestly rather
  than overselling it.

The limit: none of this survives an actor with `ALTER TABLE`, which the API's
own connection currently has. That is tracked as P-4 and classified as blocking
a real deployment, not as a refinement.

## Alternatives rejected

**Service-level checks only.** Simpler, and every rule lives in one language.
Rejected because it assumes a single writer, which is true today and will not
stay true, and because the assumption fails silently.

**Event sourcing with no cached balance.** Removes the drift class entirely,
since there is nothing to drift from. Rejected as disproportionate: it changes
every read path to get one property, and the balance-per-account read is the
hottest query in the system.

**A periodic reconciliation job as the only defence.** It exists (I-4, run by
`db:reconcile`), but as detection rather than prevention. A daily job means a
drift introduced at 09:00 is invisible until the next run — which is P-2, and is
the reason it cannot be the primary control.

## Reversibility

**Hard.** Removing the triggers is a one-line migration, but every test that
proves an invariant would have to be rewritten against the service instead, and
the guarantee would quietly weaken from "the database refuses" to "the code we
have read refuses". Tightening further — moving `balance` maintenance into the
trigger — is the open question in P-2 and P-21, and is easier than loosening.
