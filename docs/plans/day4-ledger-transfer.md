# Day 4 — Ledger and transfer: implementation plan

Branch `feat/ledger-transfer`, stacked on `feat/auth`.

The runbook calls this the critical day, and §14 says B3 "gets the most time;
B4 does not start before it". Everything on days 5 and 6 sits on top of what
lands here, and unlike auth, a defect here is not a leak — it is money that
does not add up.

The database already refuses most of the ways this can go wrong: day 2 added
deferred constraint triggers asserting I-1, I-2 and I-6 at COMMIT. That changes
what this day is. The service is not the thing that guarantees the ledger
balances; it is the thing that has to *satisfy* a guarantee already in place.
If the service is wrong, the transaction aborts rather than committing a lie.

## Global exit criteria

| # | Criterion | How it is checked |
|---|---|---|
| G-1 | `yarn verify` green | lint, build, typecheck, test |
| G-2 | **S-1** — same `Idempotency-Key` twice → 2 ledger rows, not 4, identical responses | integration |
| G-3 | **S-2** — two concurrent transfers, balance covers one → one COMPLETED, one FAILED, balance ≥ 0 | integration, genuinely parallel |
| G-4 | **S-3** — transfer from someone else's account → 403/404, no data leak | integration |
| G-5 | **S-7** — `sum(ledger) = 0` after the whole suite | integration |
| G-6 | I-1…I-6 hold under every test | the day 2 triggers, exercised for real |

## Pieces

### P1 — LedgerRepository (T-4.1 · I-3)

**Clause under test.** I-3: "A ledger entry is never modified or deleted — a DB
rule forbidding UPDATE/DELETE **and no such method exists in the repository API
at the code layer**."

**Judged on.** Whether mutation is *inexpressible*, not merely absent. A
repository that exposes the Prisma client, or returns a delegate someone can
call `.update()` on, has not satisfied this — it has just not used it yet. The
critic should try to write a line that updates a ledger row using only what the
module exports.

### P2 — TransferService.execute (T-4.2, T-4.4 · FR-4.2, I-2)

Channel-agnostic: plain input, plain output, no `req`/`res`, no HTTP status, no
`CON`/`END`.

**Clause under test.** §8.3's layer contract and FR-4.2's double-entry rule.

**Judged on.** That the same call works unchanged for `channel: "USSD"`, and
that the two entries it writes carry `balanceAfter` values that match what a
`sum()` over the account's history would produce — not just any two numbers
that happen to cancel.

### P3 — Serializable and retry (T-4.3 · FR-4.3, S-2)

One transaction at `Serializable`, retried up to three times on `P2034`.

**Clause under test.** FR-4.3, and S-2: "2 parallel transfers, balance covers
only one → one COMPLETED, one FAILED, balance ≥ 0".

**Judged on.** A test that actually runs them in parallel. Day 3 taught this
the hard way: the refresh reuse check passed its sequential test while being
completely bypassable by two simultaneous requests. Every read-then-write in
this file gets a concurrency test, not a sequential one.

**The SQL worth understanding here.** `Serializable` in Postgres is not locking
— it is optimistic. Both transactions proceed, and at COMMIT the engine checks
whether the result could have been produced by running them one after the
other. If not, one gets `40001` (which Prisma surfaces as `P2034`) and must be
retried, not reported. Retrying is part of the contract, which is why FR-4.3
says three attempts rather than "handle the error".

### P4 — Idempotency (T-4.5 · FR-4.4, S-1)

`Idempotency-Key` header, mandatory. Key plus `requestHash`; a replay returns
the stored response; same key with a different payload is a 409.

**Clause under test.** FR-4.4 in full, including the 24-hour retention.

**Judged on.** S-1 — two POSTs with one key produce **two** ledger rows, not
four — and the concurrent case: two requests with the same key arriving
together. The unique primary key is what has to arbitrate, the same lesson as
day 3's refresh claim.

### P5 — Ownership (T-4.6 · FR-4.5, S-3)

Every query filtered by the authenticated user.

**Clause under test.** FR-4.5 and §17.1's Elevation-of-privilege row.

**Judged on.** That an account id belonging to someone else produces the same
answer as an account id that does not exist. A 403 that differs from a 404 is
an existence oracle, which is the same class of defect as day 3's timing leaks.

### P6 — Limits (T-4.7 · FR-6.1, FR-6.2, FR-6.3)

Per-operation and daily limits per channel; 500 000 to a new recipient in the
first 24 hours; more than five transfers in five minutes blocks.

**Clause under test.** All three, with `LIMIT_EXCEEDED` carrying which limit in
`details` — the `limit.*` codes added on day 2.

**The SQL worth understanding here.** All three are aggregate questions over a
time window:

```sql
-- Daily total for one account, in that account's own day
SELECT COALESCE(sum(amount), 0)
  FROM transfers
 WHERE "fromAccountId" = $1
   AND status = 'COMPLETED'
   AND "createdAt" >= now() - interval '24 hours';
```

Worth doing in SQL rather than by loading rows and summing in TypeScript: the
database reads an index and returns one number, instead of shipping a day of
history over the wire to add it up locally. We will look at `EXPLAIN` for this
one and check whether `transfers_fromAccountId_createdAt_idx` is used.

### P7 — The HTTP adapter (T-4.8)

`POST /api/transfers`, authenticated, `Idempotency-Key` required.

**Clause under test.** §12.1, §12.2 ("a request without a key gets 400"), and
§12.3 for every failure it can produce.

**Judged on.** Amounts serialised as **strings** (§12.2, §9.3) — a `BigInt` that
reaches `JSON.stringify` throws, and one converted with `Number()` loses
precision above 2^53. The response must round-trip through the shared schema.

## Sequencing

P1 and P5 first — the repository shape and the ownership predicate constrain
everything else. P2 and P4 next, then P3, because the retry wraps the whole
transaction and is easier to add once there is a transaction to wrap. P6 before
P7, so the adapter has every error to map. S-7 lands last and runs over the
whole suite.

## Out of scope

Demo top-up (FR-10) and recipient lookup (FR-4.9) are day 5. Rate limiting,
helmet and CORS are day 6. History and filters are day 5, and that is where the
cursor-pagination SQL lives.

## Known constraint from day 2

The deferred triggers enforce that a `COMPLETED` transfer has exactly two
entries summing to zero, both on accounts party to it, matching its amount and
direction — checked at COMMIT. A service that writes the entries and flips the
status in one transaction satisfies this; one that commits a transfer before
writing its entries will abort. That is the intended pressure.
