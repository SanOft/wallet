# Day 2 — API skeleton: implementation plan

Branch `feat/api-skeleton`, stacked on `feat/shared-contracts` until day 1 merges.

Every piece below is judged on its own against the spec clause it cites. A piece
is done when the clause is *satisfied*, not when code exists that gestures at it.

## Global exit criteria

| # | Criterion | How it is checked |
|---|---|---|
| G-1 | `yarn verify` green | lint, typecheck, test, build across all workspaces |
| G-2 | `prisma migrate` applies to an empty database | Dockerised Postgres 17, dropped and recreated |
| G-3 | Seed run twice produces no duplicates | Run it twice, assert row counts |
| G-4 | `/health` returns the documented shape | Integration test through supertest |
| G-5 | No secret in git | `.env` ignored, `.env.example` committed |

## Pieces

### P1 — Workspace and layer skeleton (T-2.1, T-2.2 · spec §8.3)

`apps/api` boots on Express 5, TypeScript strict, with `src/adapters/http`,
`src/domain`, `src/infra` as explicit directories.

**Clause under test.** §8.3: "domain services know nothing about `req`/`res`,
HTTP status codes, or `CON`/`END`. They receive plain input objects and return
either a result or a typed domain error."

**Judged on.** Whether the boundary is *enforceable*, not merely documented. A
domain file importing anything from `express` is a failure. So is an adapter
holding business rules.

### P2 — Request identity and logging (T-2.3 · NFR-5.1, NFR-5.2)

`requestId` on every request, echoed as `x-request-id`; pino JSON logs carrying
`requestId`, `userId` when present, and latency.

**Clause under test.** NFR-5.1 (structured logs, requestId on every request) and
NFR-5.2 (never logged: passwords, tokens, PINs, full phone numbers).

**Judged on.** NFR-5.2 is the hard half. Redaction must be structural — a
configured redact list — not a convention someone remembers to follow. The critic
should try to get a phone number into a log line.

### P3 — Error contract (T-2.4 · spec §12.3)

One middleware turns a domain error into the `apiErrorSchema` envelope, with the
status read from `API_ERROR_STATUS` in `@wallet/shared`.

**Clause under test.** §12.3: the envelope shape, `code` as the contract rather
than `message`, `details` present only for `VALIDATION_ERROR`, and the status map
being the single source of truth.

**Judged on.** Whether every one of the fifteen codes produces its documented
status, and whether an unexpected throw becomes `INTERNAL` 500 with a
`requestId` rather than an Express stack trace. The response must parse through
`apiErrorSchema` itself.

### P4 — Data model (T-2.7 · spec §9.1, §9.5)

Seven tables: `User`, `Account`, `Transfer`, `LedgerEntry`, `IdempotencyRecord`,
`RefreshToken`, `AuthAttempt`.

**Clause under test.** §9.1 field by field, plus the invariants that belong in
the schema rather than in application code:

- I-5 `balance >= 0` for `type = USER`, with treasury exempted (§9.4)
- `LedgerEntry.amount` never zero
- `Transfer.amount > 0`
- `IdempotencyRecord.key` unique, `User.phone` unique
- `Transfer.idempotencyKey` unique

**Judged on.** Whether each constraint is a database `CHECK` or unique index —
something a buggy service cannot violate — rather than a comment or a TypeScript
type. Money columns must be `BigInt`, never `Float` or `Decimal` (§9.3, NFR-1.10).

### P5 — Health endpoint (T-2.5)

`GET /health` returning status, a database ping, and the latest applied
migration.

**Clause under test.** Runbook T-2.5: `200 {status, db, migration}`.

**Judged on.** Behaviour when the database is *down*: the endpoint must report
the failure rather than hang or return 200 with a lie.

### P6 — Treasury seed (T-2.8 · spec §9.4)

`SYSTEM` user owning one `TREASURY` account, the only account allowed a negative
balance.

**Clause under test.** §9.4 and G-3 idempotency.

**Judged on.** Running it twice. Also whether the treasury exemption is scoped to
`type = TREASURY` alone — a `CHECK` that accidentally lets any account go
negative fails I-5 silently.

### P7 — Environment and configuration (T-2.6 · §20.2, NFR-1.9)

`DATABASE_URL` and friends parsed through a Zod schema at boot, so a missing
variable fails at startup rather than at the first query. `.env.example`
committed, `.env` ignored.

**Clause under test.** §20.2 variable list and NFR-1.9.

**Judged on.** Whether the process refuses to start on a missing or malformed
variable.

## Sequencing

P7 and P1 first — nothing runs without configuration and a server. P4 next,
because the schema is what P5 and P6 depend on. P2 and P3 are independent of the
database and can be built alongside P4. P5 and P6 last.

## Out of scope

Auth, transfers, the ledger service itself, and rate limiting are day 3 and day 4.
This branch stands up the skeleton those land into. `TransferService` is not
written here; the tables it will write to are.

## Known blocker

A deployed Neon database (T-2.6) is not available to this session. The schema and
seed are verified against Dockerised Postgres instead, which proves the migration
and the constraints but not the hosted environment. `DATABASE_URL` for Neon
remains outstanding.
