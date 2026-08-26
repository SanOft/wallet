# Day 3 — Authentication: implementation plan

Branch `feat/auth`, stacked on `feat/api-skeleton` until PR #2 merges.

The spec's security requirements for this day are unusually specific, and most
of them are about what an attacker learns rather than what a user gets. Each
piece below is judged on the clause it cites, and several are judged on
behaviour that is invisible from a successful request.

## Global exit criteria

| # | Criterion | How it is checked |
|---|---|---|
| G-1 | `yarn verify` green | lint, build, typecheck, test |
| G-2 | **S-4** — a replayed refresh token revokes the whole family | integration test against Postgres |
| G-3 | **S-5** — unknown number ≡ wrong password, in text, status and timing | integration test measuring both paths |
| G-4 | `passwordHash` provably never reaches the wire | response parsed through `publicUserSchema` on every route |
| G-5 | The ledger invariants still hold | the day 2 suite keeps passing |

## Dependency decisions, already verified

| Package | Version | Why |
|---|---|---|
| `argon2` | 0.45.1 | Spec §8.4. Loads with Yarn's build scripts disabled — `node-gyp-build` resolves a prebuilt binary at require time. Verified: emits `$argon2id$v=19$m=19456,p=1,t=2$`, exactly NFR-1.1. |
| `jose` | 6.2.10 | **Zero dependencies**; `jsonwebtoken` pulls ten, six of them lodash micro-packages. For the library guarding authentication that is decisive. It also forces `algorithms` to be passed explicitly on verify, which is what FR-2.5 asks for. |

## Pieces

### P1 — Password and PIN hashing (T-3.1 · NFR-1.1)

`infra/crypto.ts` wrapping argon2id at `m=19456, t=2, p=1`.

**Clause under test.** NFR-1.1, and FR-1.3's "OWASP minimum configuration".

**Judged on.** That the parameters are asserted from the *hash string* rather
than from the call site — a test reading the same constant the code passes
proves nothing. Also that `verify` returns `false` on a malformed hash instead
of throwing, since the SYSTEM user's sentinel is exactly that (§9.4).

### P2 — Token configuration (T-3.4 · FR-2.4, FR-2.5)

`JWT_SECRET` joins the env schema. Access tokens are HS256, 15 minutes.

**Clause under test.** FR-2.5: "The JWT algorithm is hard-coded: `HS256`.
`alg:none` and algorithm confusion are rejected."

**Judged on.** A forged token really being rejected — the critic should mint one
with `alg: none` and one with `alg: HS512` and watch both fail. A secret shorter
than 256 bits must fail at boot, not at first signature.

### P3 — Registration (T-3.2 · FR-1.4, FR-1.5)

`POST /api/auth/register`. User and UZS account created in one transaction.

**Clause under test.** FR-1.5: a taken number returns the *same* generic
response as any other rejection — no user enumeration.

**Judged on.** Whether the two responses are byte-identical, and whether the
account really cannot exist without its user (kill the transaction halfway).
`REGISTRATION_FAILED` must not vary in status, body, or header.

### P4 — Login (T-3.3 · FR-2.2, S-5)

`POST /api/auth/login`.

**Clause under test.** FR-2.2: "Response time is comparable (even when the user
is not found, wait for a duration equal to the hash verification time)."

**Judged on.** A measured timing delta under 50 ms between "no such number" and
"wrong password" (§18.2 S-5). The obvious implementation — return early when the
user is absent — fails this by a wide margin, because an argon2 verify at
`m=19456` takes tens of milliseconds. The fix is to verify against a dummy hash.

### P5 — Refresh tokens (T-3.5, T-3.6 · FR-2.6, FR-2.7, S-4)

Opaque 256-bit random, SHA-256 hashed in the database, grouped by `familyId`.
Rotation on every use; reuse revokes the family.

**Clause under test.** §9.2 "the raw token is never stored", FR-2.6 rotation,
FR-2.7 family revocation.

**Judged on.** That a `SELECT` over `refresh_tokens` after a login contains
nothing resembling the cookie value. And S-4: replay a used token, then confirm
*every* token in that family is revoked — not just the replayed one — and that
the legitimate device is signed out too.

Cookie attributes come from FR-2.4: `httpOnly; Secure; SameSite=Strict`, 30 days.

### P6 — Session routes (T-3.7)

`GET /api/me`, `POST /api/auth/logout`.

**Clause under test.** §12.1's auth column, and FR-2 for logout revoking the
current family.

### P7 — Response validation (T-3.8 · the interesting one)

`adapters/http/respond.ts`: every route serialises through a Zod schema before
sending.

**Clause under test.** `auth.ts`'s own comment: "parsing a Prisma record through
this schema strips them, so a leak requires deleting this schema, not merely
forgetting a field."

**Judged on.** Whether that is actually true. The critic should hand a full
Prisma `User` row — `passwordHash`, `pinHash` and all — to the response helper
and confirm the wire output contains neither. A helper that only *documents* the
guarantee is the failure mode this task exists to prevent.

## Sequencing

P1 and P2 first — everything else needs a hash and a token. P3 next, because
P4's timing test needs a real registered user to compare against. P5 and P6
follow. P7 is written alongside P3 and applied to every route as it lands.

## Out of scope

Lockout and step-up (FR-2.3, FR-2.8) are deferred to September by the runbook.
Rate limiting, helmet and CORS are day 6. The PIN endpoint (`PUT /api/me/pin`)
belongs to FR-9.5 and lands with the USSD channel.

## SQL notes as we go

The user is learning SQL alongside this. Day 3 is mostly Prisma CRUD, where
Prisma earns its keep, so the SQL content here is small and honest:

- The register transaction is the first place `$transaction` matters, and it is
  worth showing what it compiles to.
- Family revocation is one `UPDATE … WHERE "familyId" = $1 AND "revokedAt" IS
  NULL` — a good first look at updating a set rather than a row.
- The real SQL work is days 4 and 5: reconciliation, history filters and cursor
  pagination.
