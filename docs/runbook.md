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
| Data model (7 tables then, CHECK constraints, I-3 trigger) | ✅ day 2, verified on Postgres 17. `RatesSnapshot` was added at B4 (P-30), so 9.1 now shows eight |
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

### Checking the PWA (F6)

Lighthouse removed its PWA category in v12, so there is no score to point at.
What replaces it, against a production build served by `vite preview`:

```bash
yarn workspace @wallet/web build
yarn workspace @wallet/web preview --port 4174
```

1. The manifest parses, names the app, is `display: standalone`, and carries a
   `maskable` icon — a maskable icon must be full-bleed, because the platform
   crops it and transparent margins come back as holes.
2. `navigator.serviceWorker.controller` is non-null **after a reload**. It is
   null on the first load by design: the worker activates and takes over on the
   next navigation.
3. With the network switched off in DevTools, a reload still renders the shell.

### The four scores, and the floor under them

All four Lighthouse categories are held at **98 or above**. Measured on
2026-08-28 at Lighthouse 13.4.1 against a production build:

| | desktop | mobile |
|---|---|---|
| Performance | 100 | **98** |
| Accessibility | 100 | 100 |
| Best practices | 100 | 100 |
| SEO | 100 | 100 |

```bash
npx lighthouse http://localhost:4176/login   --only-categories=performance,accessibility,best-practices,seo   --chrome-flags="--headless=new" --output=json --output-path=lh.json
```

Mobile performance is **at the floor, with no headroom**: FCP 1.7s, LCP 2.0s,
TBT 80ms under simulated throttling. That number is framework cost — React,
Redux Toolkit, RTK Query, the router and Zod are all needed to render a login
form, and they are ~120 KB gzipped between them. Route splitting moved the
signed-in screens out of the critical path, which was right on its own terms
but bought roughly 4 KB and did not move the score.

Buying real headroom means taking RTK Query and Zod off the anonymous path,
which is architecture, not tuning. Recorded rather than done.

#### Measuring an authenticated route

`/login` is the only route a plain Lighthouse run can reach; everything else is
behind a session. Pass the cookies instead of guessing:

```bash
curl -s -i -X POST http://HOST/api/auth/login -H 'content-type: application/json'   -d '{"phone":"...","password":"..."}' | grep -i '^set-cookie:'
# -> wallet_refresh, wallet_session
npx lighthouse http://HOST/labs/ussd --extra-headers=headers.json ...
```

Measured this way, every route scores the same: **97 performance, 100
accessibility, 100 best practices, 100 SEO** — `/login`, `/`, `/history`,
`/transfer` and `/labs/ussd` are within a point of each other, with FCP 2.0 s
and LCP 2.1 s throughout. The deep-link waterfall an authenticated route
suggests — shell, then refresh, then the route's chunk, then its data — does not
show up in the number.

**Serve the build the way a host would, or you will measure the harness.** A
plain Node static server with no `Content-Encoding` scored every route at 84,
including `/login`, whose real figure is 98. The entry chunk went out at 331 KB
instead of 106 KB. The control that caught it was measuring `/login` alongside
the route under test and noticing that the known-good page had also moved — a
single-route measurement would have been reported as a finding about that route.

#### A code-split route is not style-split

The first thing that will take the mobile score below 98 is not a heavy
dependency. It is a new screen adding a handful of Tailwind utilities nothing
else uses.

Tailwind emits **one** stylesheet for the whole application. A route can be
behind `lazy()` and still put its utilities in the render-blocking CSS that the
login screen waits for. F7 did exactly that: ten new classes, 389 bytes, and
Lighthouse mobile performance fell from 98 to 97 — LCP from ~2020 ms to
~2180 ms, with FCP and TBT unchanged, reproduced across nine interleaved pairs
against `main` on a quiet machine.

The fix is to write a lazy route's own layout as inline `style`, so the bytes
land in that route's chunk. Two things are worth knowing before spending an
afternoon on it:

- **Measure interleaved, both builds served at once.** Sequential batches drift
  enough on a working machine to invent a difference or hide one. Two of the
  wrong turns here came from comparing batches taken minutes apart.
- **Tailwind v4 scans raw file text, comments included.** Naming the classes you
  just removed regenerates them. Two of the ten came back from the sentence
  explaining their removal.

The service worker was the other suspect and was innocent, which is worth
recording so nobody re-tests it: `globPatterns` precaches every emitted chunk,
so a new route does add downloads to the first visit. Excluding the route from
the precache changed the score by nothing measurable. The stylesheet was the
whole effect.

One caveat worth knowing before it wastes an afternoon: DevTools network
throttling does **not** flip `navigator.onLine`, so the offline banner will not
appear under it. The banner is driven by the `offline` event and is covered by
`home.test.tsx`.

### The tests need their own database (P-31)

The integration suites write, and they clean nothing up. Sharing one database
with the development server means a fixture becomes a row the running app then
serves to a real session — the rates widget once showed `11900.00` dated
tomorrow, taken from `rates.test.ts`, for hours — and the accumulation is not
theoretical either: 3 440 accounts and 2 101 transfers made the I-4 invariant
check time out until it was rewritten as one aggregate.

Locally, keep two. `docker-compose.yml` creates both, on the image CI uses:

```bash
docker compose up -d --wait                              # postgres 17 on 5434
yarn workspace @wallet/api exec prisma migrate deploy
```

`--wait` returns only once the healthcheck passes, so the migration cannot
race the server's startup. `docker compose down` stops it and keeps the data;
`down -v` throws the data away, which is the way back to a clean cluster.

This file exists because for most of the project it did not. The tests ran
against a container typed out by hand months earlier and recorded nowhere, and
the morning it stopped binding there was nothing to recreate it from — `yarn
verify` could be run in CI and nowhere else. A test database that lives on one
laptop and in nobody's repository is a single point of failure with no error
message.

**If it will not bind on Windows**, and the daemon says only `An attempt was
made to access a socket in a way forbidden by its access permissions`, the
port is inside a block Windows reserves for Hyper-V and WinNAT. Those blocks
move. `netsh int ipv4 show excludedportrange protocol=tcp` lists them; ports
below 49152 are never in one, which is why this stack sits on 5434 rather than
on the 55432 it used to.

Then in `apps/api/.env`:

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | `wallet` | the dev server, and anything you demo |
| `TEST_DATABASE_URL` | `wallet_test` | `yarn test`, when set |

`TEST_DATABASE_URL` is a fallback, not a requirement: unset, the tests use
`DATABASE_URL` exactly as before. CI leaves it unset on purpose — a throwaway
container has nothing to protect, and requiring it would fail every job to fix
a problem those jobs do not have.

### FR-9.4's response budget, measured

The requirement is a reply under **10 s**, targeting **3 s**. The ceiling is
asserted in `test/ussd.test.ts` on every step of a §11.7 session. The target is
measured rather than asserted, because a CPU-time bound on shared CI hardware is
a flaky test and not a guarantee.

Five full sessions against a local server, milliseconds:

| step | min | median | max |
|---|---|---|---|
| menu | 5 | 11 | 21 |
| ask recipient | 6 | 9 | 14 |
| quote recipient | 9 | 18 | 29 |
| quote amount | 5 | 8 | 11 |
| **transfer (PIN + ledger)** | **104** | **143** | **229** |

The last row is the only expensive one and the only one that should be: argon2
PIN verification plus a `Serializable` transaction. 229 ms worst against a
3 000 ms target is thirteen times inside it.

What this does not tell you: it is a local database on loopback. A hosted
Postgres adds a round trip per query, and Render's free tier sleeps (P-27) — a
cold start is not a slow response, it is a refused one, and no timing budget
covers that.

### When a migration fails against production

`prisma migrate deploy` refuses to apply anything after a migration has failed
on the target database (P3009). That is correct — the schema is in a state
nobody planned — but it means one bad migration blocks every later one until a
person clears the record.

It happened once, and the cause is worth keeping:

> `ERROR: permission denied to set parameter "session_replication_role"`

The ledger invariants migration suspended the append-only trigger with a session
parameter that requires **superuser**. It passed locally and in CI, because both
run as superuser in a throwaway container, and failed on Neon, where the role is
an owner and not a superuser. `ALTER TABLE ... DISABLE TRIGGER USER` needs only
ownership and does the same job.

**The lesson is not about that statement.** It is that a migration is tested
against the privileges of the machine that runs it, and the deployed database
grants fewer.

CI now closes that gap: the `migrations` job creates a `NOSUPERUSER` role,
gives it a database of its own, **proves the role really is restricted** — a
probe that could set the parameter after all would pass vacuously — and applies
every migration as it. Verified to catch the real thing: reintroducing
`SET LOCAL session_replication_role` turns that job red with the same
`permission denied` the production deploy hit.

One consequence worth knowing before optimising it away: the trigger suspension
in that migration is **unconditional** rather than guarded on there being rows
to repair. The guard is faster and it is also a blind spot — on the fresh
database CI uses there is nothing to repair, so the privileged statement would
never run and the job would pass without testing the line that failed. The
tested path has to be the executed path.

To reproduce locally:

```bash
psql -c "CREATE ROLE probe LOGIN PASSWORD '...' NOSUPERUSER"
psql -c "CREATE DATABASE probe_db OWNER probe"
DATABASE_URL=postgresql://probe:...@localhost:5434/probe_db   yarn workspace @wallet/api exec prisma migrate deploy
```

To clear a failed record, run the **Resolve a failed migration** workflow from
the Actions tab with the directory name. It is `workflow_dispatch` only: a
pipeline that resolved its own failures would turn a blocked deploy into a
corrupted one. Use `rolled-back` unless you have checked the schema by hand —
Prisma runs each migration in a transaction, so a failure normally leaves
nothing behind.

### Checking it by hand

`docs/smoke-plan.md` walks one person from registration through a USSD transfer
and back to the web history, against a local API and the PWA on `:5173`.

It deliberately does not repeat the automated suites. It covers the three
things they cannot: that the parts add up, what a screen actually looks like,
and failures that have to be real rather than stubbed — a dropped connection, a
second tab, a reload mid-flow.

### Two accounts that survive a reseed

`yarn workspace @wallet/api db:seed:demo` creates the pair used for
demonstrating the product, and re-creates them after any `down -v`:

| | |
|---|---|
| Sanjar Juraev | `+998884615500` |
| Amina Jurayeva | `+998884625500` |
| password | `orbit-walnut-lantern-quiet` |
| USSD PIN | `1234` |

Separate from `prisma/seed.ts`, which is infrastructure — the treasury, without
which a top-up cannot balance — and is imported by the integration suite, so
anything added there becomes rows every test starts with.

Three properties worth keeping if this is ever edited:

- **It goes through the domain services**, not through Prisma. Writing
  `balance: 100_000_000n` onto an account would create money with no ledger
  entries behind it and break I-4 at the next reconciliation, with nothing
  saying where the drift came from. `sum(ledger) = 0` still holds after seeding,
  which is the check worth re-running.
- **It converges rather than skipping.** Each property — the user, the PIN, the
  funding — is checked and repaired on its own. The first version skipped when
  the row existed, and a run that failed between registration and `setPin` left
  an account with no PIN and no money that every later run called done.
- **It refuses to run with `NODE_ENV=production`.** Two named accounts with a
  published password and PIN `1234` are exactly what must never reach a real
  deployment.

These accounts live in `wallet`, not `wallet_test`, which is the whole reason
P-31's two-database split has to be set up before seeding them: with
`TEST_DATABASE_URL` unset the suite truncates whatever `DATABASE_URL` points at,
and "permanent" accounts last until the next `yarn test`.

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
| T-2.7 | Prisma schema: the 7 tables §9.1 had then + `CHECK` constraints | `prisma/schema.prisma` | `prisma migrate dev` clean on an empty DB |
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
| T-3.8 | **Server validates its own responses** on every route | `adapters/http/respond.ts` | `passwordHash` provably never reaches the wire — proved by handing the helper a full Prisma row, not by every call site happening to pass a narrowed one |

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

#### T-6.1 — what has to be done by hand

The pipeline is written and cannot run until these exist. Everything else in
Day 6 is automated.

**Neon.** Create a project and a database, then copy **both** connection
strings from the dashboard — they differ by one word in the hostname:

| String | Hostname | Used by |
|---|---|---|
| Pooled | contains `-pooler` | the running service (`DATABASE_URL`) |
| Direct | no `-pooler` | `prisma migrate deploy` (`DATABASE_URL_UNPOOLED`) |

Both are required. A migration takes advisory locks and issues DDL across
several statements, and a transaction pooler may hand those to different
backends — the failure is a half-applied migration, not a refusal.

**Render.** Create a Web Service from this repository.

| Setting | Value |
|---|---|
| Build command | `corepack enable && yarn install --immutable && yarn build` |
| Node version | pinned by `.node-version` (22); do not set `NODE_VERSION` |
| Start command | `yarn workspace @wallet/api start` |
| Health check path | `/health` |
| Auto-Deploy | **Off** |

Auto-Deploy must be off. With it on, Render redeploys the moment `main` moves,
which races the migration job and can start the new code against the old schema
— the one ordering §19.1 exists to prevent.

Environment variables on the service: `DATABASE_URL`, `JWT_SECRET` (32+ chars,
generate it), `CORS_ORIGINS` (the Vercel origin), `NODE_ENV=production`. `PORT`
is supplied by Render. Leave `REFRESH_COOKIE_DOMAIN` unset (ADR-0009).

**Vercel.** Import the repository with `apps/web` as the root. Then set the
rewrite destination in `apps/web/vercel.json` to the Render URL — it ships as
`https://set-me-at-t-6-1.invalid/...` on purpose, so a forgotten step fails
loudly instead of routing `/api` somewhere unintended.

**The runtime role** (P-4). Connect to the Neon database as the owner and run
`apps/api/prisma/runtime-role.sql`, replacing `__PASSWORD__` with a generated
secret. Then set `DATABASE_URL` to that role everywhere below.
`DATABASE_URL_UNPOOLED` keeps naming the owner, because migrations create and
alter and the runtime role deliberately cannot.

The file is idempotent and is also how the password is rotated: change the
secret and run it again. `runtime-role.test.ts` runs the same file in CI and
proves both halves — the application works on that connection, and the five
privileged statements are refused.

**GitHub secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DATABASE_URL` | The **pooled** Neon string |
| `DATABASE_URL_UNPOOLED` | The **direct** Neon string, for migrations |
| `RENDER_DEPLOY_HOOK_URL` | Render → service → Settings → Deploy Hook |
| `PRODUCTION_URL` | The Vercel origin, e.g. `https://wallet.vercel.app` |

`PRODUCTION_URL` is the *web* origin, not the Render one: the smoke test has to
exercise the path a browser takes, including the rewrite, or it proves nothing
about the deployment users will meet.

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

Step-up hardening · history endpoint with filters · exchange rates · **the entire frontend** (F0–F7) · USSD adapter · PWA offline + outbox · SSE live balance · Storybook · the ADR-0003 comparison lab.

---

## 5. Three standing rules

**Architecture is frozen.** New ideas go to `docs/PARKING.md`, undiscussed, and are reopened in September. Reason: every re-design costs 2–3 hours, and there are 33 in total.

**Push at the end of every day.** A day ends with `verify` green and a PR open. Never sleep on a half-broken state.

**Prove the effect, and guard the proof.** A control is not tested by a test
that shows the control is *present*. It is tested by one that shows it *works* —
and by a second assertion that fails when the check itself stops working.

This is written down because one day produced five instances of the same
failure, every one of them green:

| What was wrong | What said nothing |
|---|---|
| `globalRateLimit()` built per request, so every caller got a fresh counter and the limit never fired | the middleware was mounted, the branch ran, coverage counted it |
| Five escalation assertions on the runtime role passed on a connection error (`28P01`) rather than a privilege refusal (`42501`) | `rejects.toThrow()` |
| The contrast scan's regexes carried a literal backspace byte, so it found zero tokens | `it.each` over an empty list |
| The layer guard's `code()` stripped string literals, so three of its four rules could never match | the rules were all plainly visible in the source |
| Deploy monitors reported "settled" from a different commit's run, three times | the run they named really had finished |

None of these is exotic. Each is the ordinary shape of a check that has stopped
checking, and coverage cannot see any of them, because the code ran.

What a guard looks like in practice, all of it already in the suite:

- Assert the derived list is not empty before iterating it
  (`scenario-coverage.test.ts`, `contrast.test.ts`).
- Assert the *reason* a thing was refused, not that it threw
  (`runtime-role.test.ts` rejects `28P01` explicitly).
- Assert the fixture was read at all before asserting anything about it
  (`layer-contract.test.ts` checks the domain directory has files).
- Mutate the thing under test and require the test to fail. If it does not, the
  test is describing the code rather than checking it.

The last one is the whole rule in one line. Nothing here is a substitute for it.

*The same discipline applies to a red run.* A failure is explained, not
classified. Twice in one day the classification would have been wrong in
opposite directions: two suites timed out right after a change and the change
looked like the cause, from one observation on each side — three more runs said
it was load. Then a *documentation* commit turned `verify` red, which a change
to prose cannot do, so the obvious reading was a flake. It was a `500` on the
onboarding path: the advisory lock that queues concurrent top-ups had never been
given a transaction budget sized for a queue, and one to five callers in twelve
were being told the server had broken. It passes 3/3 in isolation and only
appears under the load of a full run.

Neither of those is found by re-running. Both are found by reading the failure.
