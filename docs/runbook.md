# Wallet — Runbook

**Execution guide.** The spec (`docs/spec.md`) says *what* gets built. This document says *in what order, and verified how*.

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-08-25 |
| **Goal** | By 31 Aug: a deployed, tested backend — "ledger live" |
| **Pace** | 5–6 h/day × 6 days ≈ 33 hours |
| **Location** | `docs/runbook.md` |

---

## 0. Current state

| | Status |
|---|---|
| Monorepo scaffold (Yarn 4 workspaces, `nodeLinker: node-modules`) | ✅ |
| `tsconfig.base.json` (strict + 8 extra flags) | ✅ |
| `packages/shared/phone.ts` (E.164, region registry, normalize, format) | ✅ T-1.1 done, 17 tests |
| `packages/shared/money.ts` (ISO 4217, minor units, limits, format) | ✅ |
| `packages/shared/error.ts` (15 API codes + field codes + status map) | ✅ |
| `packages/shared/auth.ts` (register/login, publicUser, authResponse) | ✅ |
| `packages/shared/index.ts` (barrel: re-exports all four modules) | ✅ T-1.2 done |
| `yarn verify` + CI | ✅ `lint → build → typecheck → test`, CI runs the same command |
| Backend skeleton (`apps/api`: layers, requestId + pino, error envelope, `/health`) | ✅ day 2 |
| Data model (7 tables, CHECK constraints, I-3 trigger) | ✅ day 2, verified on Postgres 17 |
| Neon project + hosted `DATABASE_URL` (T-2.6) | ❌ outstanding — local Docker Postgres used for verification |
| Auth, ledger, transfers | ❌ days 3–4 |

---

## 1. The verification loop

There is exactly **one** command in this project. You run it, and CI runs it — so "works on my machine" cannot happen.

```bash
yarn verify
```

It runs, in this order:

```
lint  →  build  →  typecheck  →  test
```

Lint runs first because it is the cheapest. Build comes next, not last: `apps/*` typecheck against the **emitted** types of `packages/*`, so on a fresh clone there is nothing to typecheck against until the build has run. Ordering it last made `verify` pass locally and fail on any machine without a `dist/`.

### Root `package.json` scripts

```json
{
  "scripts": {
    "lint": "biome check .",
    "format": "biome check . --write",
    "typecheck": "yarn workspaces foreach --all --topological run typecheck",
    "test": "yarn workspaces foreach --all run test",
    "build": "yarn workspaces foreach --all --topological run build",
    "verify": "yarn lint && yarn build && yarn typecheck && yarn test"
  }
}
```

`--topological` guarantees `packages/shared` builds **before** `apps/*`. Without it `apps/api` tries to import a `dist/` that does not exist yet.

> If `yarn workspaces foreach` is not found: `yarn plugin import workspace-tools`.

### Loop protocol

```
1. yarn verify
2. If red → read the FIRST error only
      (later errors are usually consequences of the first — do not read them yet)
3. Fix that one error
4. yarn verify   ← from the top, again
5. Repeat 2–4 until green
6. Commit → push → PR
```

**Two rules:**

- **Never** commit on a red `verify`.
- After a fix, re-run the **whole** `verify`, not just the stage that failed. A fix can break something upstream.

### CI runs the same command

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - run: yarn install --immutable
      - run: yarn verify
      - run: yarn npm audit --all --recursive
```

`--immutable` makes CI fail if the install would modify the lockfile — so "CI installed a different version" is impossible.

`main` is protected: no merge unless CI is green.

---

## 2. Daily plan

Every task carries: **ID · what · files · acceptance criteria**. Each day ends with `verify` green and pushed.

### Day 1 — Close the contracts, build the loop

| ID | Task | Files | Done when |
|---|---|---|---|
| T-1.1 | `phone.ts` three fixes: (a) registry keys `uz`/`us` → `UZ`/`US` (FR-1.1); (b) `normalizePhone` guard `if (/\d+/…)` → `if (!/^\d+$/…)` — the unanchored regex short-circuits every input, so the function currently never normalizes and the branches below it are dead code; (c) US `example` `'+1234567890'` → 12 chars (`callingCode:'1'` + `nationalNumberLength:10`) | `packages/shared/src/phone.ts` | `normalizePhone('90 123 45 67') === '+998901234567'` **and** `normalizePhone('998901234567') === '+998901234567'`; `createRegionalPhoneSchema('UZ')` accepts `+998901234567`, rejects `998901234567` |
| T-1.2 | `index.ts` re-exports all four modules | `packages/shared/src/index.ts` | `yarn workspace @wallet/shared build` clean |
| T-1.3 | Install Vitest, add `test` script to `packages/shared` | root, `packages/shared/package.json` | `yarn test` runs (even with 0 tests) |
| T-1.4 | Biome (lint + format) instead of ESLint + Prettier. `typescript-eslint` cannot run here: it needs `typescript` `>=4.8.4 <6.1.0`, and TS 7.0.2 (native port) ships no `typescript.js` compiler API for its parser. Biome parses TypeScript itself, so it is unaffected — and replaces two toolchains with one dependency | `biome.json`, root | `yarn lint` clean, wired as the first stage of `verify` |
| T-1.5 | Root `verify` script | `package.json` | `yarn verify` fully green |
| T-1.6 | CI workflow | `.github/workflows/ci.yml` | CI green on the PR |
| T-1.7 | Protect `main` (GitHub settings) | — | Merge blocked without CI |
| T-1.8 | Commit spec + runbook | `docs/` | `docs/spec.md`, `docs/runbook.md` in repo |

**Outcome:** PR `feat/shared-contracts` merged. **Stage 2 closed.**

---

### Day 2 — Backend skeleton and database

| ID | Task | Files | Done when |
|---|---|---|---|
| T-2.1 | Express + TS skeleton, fill the `apps/api` workspace | `apps/api/*` | `yarn workspace @wallet/api dev` boots |
| T-2.2 | Layers: `adapters/http`, `domain`, `infra` (§8.3) | `apps/api/src/*` | Empty, but boundaries explicit |
| T-2.3 | `requestId` middleware + pino JSON logs | `adapters/http/middleware` | Every response carries `x-request-id` |
| T-2.4 | Error middleware — `apiErrorSchema` shape, status from `API_ERROR_STATUS` | `adapters/http/errorHandler.ts` | A thrown domain error returns correct JSON |
| T-2.5 | `GET /health` including a DB ping | `adapters/http/routes/health.ts` | `200 {status, db, migration}` |
| T-2.6 | Neon project + `DATABASE_URL` | `.env`, `.env.example` | Connection works |
| T-2.7 | Prisma schema: 7 tables (§9.1) + `CHECK` constraints | `prisma/schema.prisma` | `prisma migrate dev` clean on an empty DB |
| T-2.8 | Seed: `SYSTEM` user + `TREASURY` account (§9.4) | `prisma/seed.ts` | Running it twice creates no duplicates |

**Outcome:** PR `feat/api-skeleton`. `verify` green.

---

### Day 3 — Authentication

| ID | Task | Files | Done when |
|---|---|---|---|
| T-3.1 | Install `argon2`, wrap hash/verify (`m=19456, t=2, p=1`) | `infra/crypto.ts` | Unit test: hash ≠ password, verify true/false |
| T-3.2 | `POST /auth/register` — `registerRequestSchema`, user + account in one transaction | `domain/AuthService.ts` | Taken number returns `REGISTRATION_FAILED` (generic text) |
| T-3.3 | `POST /auth/login` — timing-safe (wait the same as a verify even when the user is absent) | `domain/AuthService.ts` | **S-5** green |
| T-3.4 | JWT access token (HS256, algorithm pinned, 15 min) | `infra/jwt.ts` | A token with a different `alg` is rejected |
| T-3.5 | Refresh: opaque token, SHA-256 hash in DB, `familyId` | `domain/AuthService.ts` | Raw token never stored |
| T-3.6 | `POST /auth/refresh` — rotation + reuse detection | `domain/AuthService.ts` | **S-4** green |
| T-3.7 | `GET /me`, `POST /auth/logout` | `adapters/http/routes/auth.ts` | Responses parsed through `publicUserSchema` |
| T-3.8 | **Server validates its own responses** on every route | `adapters/http/respond.ts` | `passwordHash` provably never reaches the wire |

**Outcome:** PR `feat/auth`. S-4, S-5 green.

---

### Day 4 — Ledger and transfer *(the critical day)*

| ID | Task | Files | Done when |
|---|---|---|---|
| T-4.1 | `LedgerRepository` — `create` and `read` only. **No** `update`/`delete` method exists (I-3) | `infra/LedgerRepository.ts` | Mutation is not expressible in the API |
| T-4.2 | `TransferService.execute()` — channel-agnostic, knows nothing about `req`/`res` | `domain/TransferService.ts` | Takes and returns plain objects only |
| T-4.3 | Serializable transaction + retry up to 3× on `P2034` | `domain/TransferService.ts` | **S-2** green |
| T-4.4 | Double-entry: exactly 2 rows summing to 0, plus `balanceAfter` | `domain/TransferService.ts` | **I-2**, **I-6** green |
| T-4.5 | Idempotency: key + `requestHash`, 24 h, replay returns the stored response | `domain/IdempotencyStore.ts` | **S-1** green |
| T-4.6 | Ownership check on every query (`where: { id, userId }`) | `domain/*` | **S-3** green |
| T-4.7 | Limits (FR-6.1, FR-6.2, FR-6.3), per channel | `domain/TransferService.ts` | `LIMIT_EXCEEDED` carries which limit |
| T-4.8 | `POST /transfers` adapter | `adapters/http/routes/transfers.ts` | Missing `Idempotency-Key` → `400` |

**Outcome:** PR `feat/ledger-transfer`. S-1, S-2, S-3 green.

---

### Day 5 — Top-up, lookup, tests

| ID | Task | Files | Done when |
|---|---|---|---|
| T-5.1 | `POST /accounts/topup` — treasury → user, through `TransferService` (FR-10) | `domain/TransferService.ts` | `sum(ledger) = 0` still holds |
| T-5.2 | `GET /recipients/lookup` — masked name, 20/hour limit | `adapters/http/routes` | Unknown number → `RECIPIENT_NOT_FOUND` |
| T-5.3 | `GET /accounts` — balance + `publicUser` | `adapters/http/routes` | Amounts serialised as **strings** |
| T-5.4 | **S-7**: assert `sum(ledger) = 0` after every test suite | `apps/api/test/invariants.test.ts` | Global invariant enforced |
| T-5.5 | Integration tests S-1…S-5 against Dockerised Postgres | `apps/api/test/*` | All five green |
| T-5.6 | Coverage: `TransferService` + ledger ≥ 90% | — | Report produced |

**Outcome:** PR `feat/topup-and-tests`.

---

### Day 6 — Deploy and documentation

| ID | Task | Files | Done when |
|---|---|---|---|
| T-6.1 | Render service, environment variables (§20.2) | Render dashboard | Service boots |
| T-6.2 | Deploy order: `migrate deploy` → API | `.github/workflows/deploy.yml` | Migration runs first |
| T-6.3 | Production smoke: `/health` + register + login + transfer | script | All four 2xx |
| T-6.4 | `helmet`, CORS allowlist, rate limits | `adapters/http/app.ts` | Security checklist (§17.3) complete |
| T-6.5 | README: architecture diagram, how to run, links to spec | `README.md` | A stranger can run it in 5 minutes |
| T-6.6 | ADRs 0001–0006, plus 0007 (SSE) and 0008 (FE architecture) | `docs/adr/` | One page each |

**Outcome:** live API, green CI, documented repo.

---

## 3. Mandatory test scenarios

These block merge. Each is written on the day shown:

| # | Scenario | Day |
|---|---|---|
| S-1 | Same `Idempotency-Key` twice → 2 ledger rows, not 4 | 4 |
| S-2 | Two concurrent transfers, only one can be funded → one FAILED, balance ≥ 0 | 4 |
| S-3 | Transfer from someone else's account / read someone else's history → 403/404 | 4 |
| S-4 | A used refresh token replayed → the whole family is revoked | 3 |
| S-5 | Login with an unknown number ≡ login with a wrong password (text, status, timing) | 3 |
| S-7 | `sum(ledger) = 0` — global invariant | 5 |

*(S-6, S-8, S-9 arrive in September with the UI, USSD and outbox.)*

---

## 4. Deferred to September

Lockout / step-up hardening · history endpoint with filters · exchange rates · **the entire frontend** (F0–F7) · USSD adapter · PWA offline + outbox · SSE live balance · Storybook · the ADR-0003 comparison lab.

---

## 5. Two standing rules

**Architecture is frozen.** New ideas go to `docs/PARKING.md`, undiscussed, and are reopened in September. Reason: every re-design costs 2–3 hours, and there are 33 in total.

**Push at the end of every day.** A day ends with `verify` green and a PR open. Never sleep on a half-broken state.