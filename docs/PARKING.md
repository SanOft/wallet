# Parking lot

Ideas and known gaps raised while the architecture is frozen (runbook §5).
Nothing here is scheduled until the freeze lifts, but everything here is real:
each entry was found by review, not imagined.

**Rule:** write it down, then go back to the task at hand. A re-design costs
2–3 hours and there are 33 in total.

## Open

| # | Raised | Gap | Why it is parked rather than fixed |
|---|---|---|---|
| P-2 | Day 2 | **`Account.balance` can drift from `sum(ledger)` with nothing detecting it in real time.** I-4 is specified as a daily reconciliation job (§20.4), so a drift introduced at 09:00 is invisible until the next run. The deferred constraint trigger now proves the *entries* balance, but nothing ties the cached snapshot to them. Options: have the trigger maintain `balance` and `balanceAfter` rather than trusting the writer, or assert them at COMMIT. | Changes the write model day 4's `TransferService` is being written against. Deciding it now, before that service exists, would be guessing. |
| P-3 | Day 2 | **CI pins its Postgres by floating tag** (`postgres:17-alpine`). Every dependency is pinned through the lockfile; the database the integration tests run against is not, so a green run is not reproducible months later. | One-line fix, but a digest pin belongs with the wider CI hardening in P-5. |
| P-4 | Day 2 | **The API connects as a superuser that owns its own tables.** The append-only trigger, the treasury guard and the balance constraints all hold against ordinary DML, and none of them survives `ALTER TABLE … DISABLE TRIGGER`, `CREATE OR REPLACE FUNCTION`, or `session_replication_role = replica` — all available to the owner. The real fix is a runtime role that owns nothing and can only `SELECT`/`INSERT`/`UPDATE` on the tables it needs. | Deployment work, and it needs the hosted database (T-2.6) that does not exist yet. Until then the honest claim is "a bug in service code cannot corrupt the ledger", not "nothing can". The migration says so in its own header. |
| P-5 | Day 2 | **CI supply chain.** `actions/checkout@v4` and `actions/setup-node@v4` are mutable tags, not SHAs. There is no `permissions:` block, so `GITHUB_TOKEN` takes the repository default. No `timeout-minutes`. Only Node 22 is exercised although `engines` allows `^22 \|\| >=24`. | A batch of related changes to one file; worth doing as one deliberate pass rather than piecemeal. |
| P-6 | Day 2 | **gitleaks is named by the spec three times (NFR-1.9, §17.3, §19.1) and exists nowhere.** `.env` is correctly ignored and untracked, so the outcome holds by discipline — the automated control does not. | Belongs with P-5. |
| P-7 | Day 2 | **Coverage is not measured.** NFR-6 asks for domain ≥ 90% and overall ≥ 70%; `@vitest/coverage-v8` is not installed and `verify` never runs it. The target is currently an aspiration with no instrument. | Meaningful only once the domain it should cover exists (day 4). Adding a threshold against a health-check-only service would measure nothing. |
| P-8 | Day 2 | **Idempotency keys share one global namespace.** `idempotency_records.key` is the sole primary key, so one user can pre-claim a key another will use and turn their request into a 409 — a cross-tenant denial of service on the money path. `transfers.idempotencyKey` has the same shape independently. `@@id([userId, key])` fixes it. | Deviates from the §9.1 ER diagram, which shows `key` as the PK. Changing both the model and the spec is a contract decision, and the practical risk is low while keys are unguessable UUID v4. |
| P-9 | Day 2 | **§12.2 mandates a 400 for a missing `Idempotency-Key` and §12.3 has no code for it.** `VALIDATION_ERROR` with `path: ["Idempotency-Key"], code: "field.required"` is the cheapest resolution. | No money route exists yet. Decide it when B3 lands, in the same change. |
| P-10 | Day 2 | **`noRestrictedImports` is not wired**, so §8.2's one-way dependency rule is held by review rather than by a rule. Behaviourally it is obeyed today: `packages/shared` imports only `zod`, `apps/api` imports only `@wallet/shared` and npm packages. | Worth doing when `apps/web` has code — one workspace cannot import another that is empty. |
| P-11 | Day 2 | **`trust proxy` is asserted only in a comment.** Off-Render, `req.ip` and `req.secure` are client-controlled, because the single hop being trusted is then the caller. Day 3–6 rate limiting will bucket on `req.ip`. | Needs a test that pins the behaviour in both topologies; write it with the rate limiter that depends on it. |
| P-12 | Day 2 | **Spec ER drift.** §9.1 shows `USER ||--|| ACCOUNT` (one-to-one) while the schema allows one account per currency; and `TRANSFER \|o--\|\| IDEMPOTENCY_RECORD` is not modeled — `transfers.idempotencyKey` is a bare unique column with no foreign key. | The schema is the more useful shape (multi-currency is a v2 goal, §21 Q-3). Amend the diagram rather than the schema, as part of a spec pass. |

## Closed

| # | Raised | Gap | Resolution |
|---|---|---|---|
| P-1 | Day 2 | §12.3 had no code for a request that reached no route, an unparseable body, or an oversized one — all three left the API as HTML or as a *retryable* `INTERNAL 500`. | Fixed on `feat/api-skeleton`: `NOT_FOUND`, `MALFORMED_BODY` and `PAYLOAD_TOO_LARGE` added to the catalog and to `packages/shared`, with a terminal 404 handler and body-parser mapping. Covered by `apps/api/test/contract.test.ts`. |
