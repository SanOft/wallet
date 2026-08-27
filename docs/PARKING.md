# Parking lot

Known gaps, each found by review rather than imagined, each with the reason it
was not fixed on the spot.

## Two bars, and why the difference matters

This started as a portfolio project and the disclaimer in `spec.md` is still
accurate: no real money moves through it, and there is no licence. But the
architecture was built to the standard Appendix A states — *"prove that today's
architecture can absorb real payments without a rewrite"* — and the intent is a
product, not a demonstration.

So the list below is triaged against the **product** bar, not the demo one. The
distinction is not academic: several entries were reasonable to defer while the
only user was a reviewer, and stop being reasonable the moment a real person's
identity or money is in the system.

| Tier | Meaning |
|---|---|
| **A** | Blocks the first real user. Not "should fix" — the system is unsafe or broken without it. |
| **B** | Blocks running unattended, or at more than one instance. Fine while someone is watching; not fine as a service. |
| **C** | Quality and maintenance. Genuinely September. |

**Rule while the architecture is frozen (runbook §5):** write it down, then go
back to the task at hand.

---

## Tier A — blocks the first real user

| # | Raised | Gap | Why it is A, and what closing it takes |
|---|---|---|---|
| P-4 | Day 2 | **The API connects as a superuser that owns its own tables.** The append-only trigger, the treasury guard and the balance constraints all hold against ordinary DML, and none survives `ALTER TABLE … DISABLE TRIGGER`, `CREATE OR REPLACE FUNCTION`, or `session_replication_role = replica`. | The ledger's guarantees are the product. A compromised application process — the most likely thing to be compromised — can currently rewrite them, which is why the migration header claims only that "a bug in service code cannot corrupt the ledger", not that nothing can. Closing it is a runtime role that owns nothing and holds only `SELECT`/`INSERT`/`UPDATE` on the tables it needs. Needs the hosted database (T-2.6). **Do the credential rotation in the same pass:** the deployed role is `wallet_owner`, its password has been exposed once outside the secret stores, and closing this item already means editing `DATABASE_URL` in all three places — `.env.neon`, the platform environment, and the two repository secrets. Rotating separately edits the same three twice. |
| P-15 | Day 3 | **FR-2.3 lockout is not implemented.** `AuthAttempt` rows are written but nothing counts them; `AUTH_LOCKED` exists in the catalog, the status map and a test, for a code the application can never emit. `Retry-After` appears nowhere. | With real accounts this is account-takeover exposure, not a missing feature. The IP rate limit added at T-6.4 raises the cost of bombardment but does not bound attempts *per account*, which is what FR-2.3 specifies and what a shared NAT or a botnet defeats. The rows have been written since day 3 precisely so the counter has history when it lands. |
| P-16 | Day 3 | **Access tokens outlive revocation by up to fifteen minutes**, including the attacker's, because a JWT is self-contained and there is no revocation list. | Reuse detection exists to end a stolen session (FR-2.7). Ending it fifteen minutes later, on endpoints that move money, is most of the way to not ending it. A `tokensValidAfter` timestamp checked on the money endpoints closes it, and those endpoints now exist. |
| P-8 | Day 2 | **Idempotency keys share one global namespace.** `idempotency_records.key` is the sole primary key, so one user can pre-claim a key another will use and turn their transfer into a `409`. `transfers.idempotencyKey` has the same shape independently. | A cross-tenant denial of service on the money path. Unguessable UUIDs make it impractical *today*, which is a statement about clients we do not control — a buggy or hostile client that reuses a fixed key breaks other people's payments. `@@id([userId, key])` fixes it and deviates from §9.1's ER diagram, so the spec changes with it. |
| P-11 | Day 2 | **`trust proxy` is asserted only in a comment, and the hop count is now genuinely uncertain.** Off the load balancer, `req.ip` and `req.secure` are client-controlled. ADR-0009 added a second proxy in front of the first, and `app.set("trust proxy", 1)` encodes a count that was chosen for the old chain. | Every rate limit keys on `req.ip`, so a wrong count either buckets every caller into one budget or trusts a forged header. What each vendor puts in `X-Forwarded-For` is a claim about runtime behaviour and has to be measured, not reasoned about — T-6.3's production smoke is where it gets settled, together with the test pinning both topologies. |

---

## Tier B — blocks running unattended, or at more than one instance

| # | Raised | Gap | Why it is B |
|---|---|---|---|
| P-22 | Day 6 | **Rate limiting and the lookup counter are in-process.** `express-rate-limit`'s default store and the `Map` in `routes/recipients.ts` both live in one Node process, so the limits are per-instance and reset on restart. | Render's free tier runs one instance, so this is correct *today* and wrong the moment there are two — the effective limit silently multiplies by the instance count. It also resets on every deploy and every cold start (§20.3), which is a scheduled bypass rather than an edge case. A shared store is the fix, and it should move both counters at once. |
| P-26 | Day 6 | **The production smoke test writes to the production database and cleans up nothing.** T-6.3 registers two accounts, mints demo funds and completes a transfer on every deploy. The numbers come from the unassigned `+998 33` range so they are recognisable, but nothing removes them, and FR-10.3's three-per-day allowance is consumed by a machine. | The same failure as P-17, in the environment where it is least visible. Deleting them needs either an endpoint that does not exist or a scheduled job that does — and the right answer is probably a single reserved smoke identity reused each run, which is a decision about what a deploy gate is allowed to touch. Recorded now because the growth starts with the first deploy. |
| P-27 | Day 6 | **A sleeping instance refuses requests rather than queueing them.** Render's free tier spins down after inactivity, and while it wakes, its edge answers `404` with `x-render-routing: no-server`, `text/plain`, and no request id — observed four times in a row on `POST /api/auth/register` between two successful calls. The first person to open the app after a quiet period gets a hard failure, not a slow load. | Nothing in the API can fix it: the request never reaches the process. The options are a paid instance, an external pinger, or a client that distinguishes "not running" from "broken" and retries — and only the last is free. The smoke test already does that, by requiring the `x-request-id` the service sets itself; the PWA will need the same rule when it exists (F1). Until then it is a demo-grade availability floor, and worth stating plainly rather than discovering during a demonstration. |
| P-2 | Day 2 | **`Account.balance` can drift from `sum(ledger)` with nothing detecting it in real time.** I-4 is a daily job (§20.4), so a drift at 09:00 is invisible until the next run. | A day of wrong balances is a day of real users deciding on a wrong number, and by then the transfers built on it have happened too. The options are to have the trigger maintain `balance` rather than trust the writer, or to assert it at COMMIT. Now decidable: `TransferService` exists, so this is no longer guessing at a write model that has not been written. |
| P-21 | Day 5 | **`balanceAfter` is validated by nothing** — not the CHECK, not `assert_transfer_balanced`, not `reconcile`. §9.2 sells the column as making an audit O(1). **No longer hypothetical:** the development database carries three breaks in the treasury's `balanceAfter` chain (gaps of 300 000, 1 000 000 and 1 000 000 tiyin, found with `LAG()` over the ordered entries), and every entry written after them inherits the wrong running total. | Same family as P-2 and should be decided with it. Note what the repair could *not* do: the entries are immutable by trigger, so restoring `accounts.balance` from `SUM(amount)` fixes I-4 and leaves the audit column permanently wrong for those rows. An untrustworthy audit trail is worse than none, because a reconciliation built on it reads from the source it is meant to police. |
| P-23 | Day 6 | **§17.1 mitigates "token theft via XSS" with a CSP on the wrong origin.** The access token lives in memory on the web origin (FR-2.4), which Vercel serves; the CSP is a header on the Render API. A policy on one registrable domain constrains nothing that can reach a variable on another. `apps/web` is an empty stub and neither it nor the spec defines a CSP for the document origin. | The API's `default-src 'none'` is correct and worth keeping — it is simply not this mitigation. Closing it means writing the document-origin policy, which belongs with the first frontend code (F1), not before it. The row should be marked as pending in the meantime rather than ticked. |
| P-24 | Day 6 | **`requestId` is caller-controlled.** Any well-formed inbound UUID is honoured and echoed, and `x-request-id` is on the CORS allowlist. §17.1 answers Repudiation with these logs; a caller can collapse many requests onto one id, or replay one it has seen. | The format check stops log injection, which was its stated purpose. Correlation integrity needs a second, server-minted id that the caller cannot set, logged alongside the one it supplied — a logging-contract change (NFR-5) worth making once, with the trace id, rather than twice. |
| P-25 | Day 6 | **Per-IP limits in a CGNAT market.** 20 auth requests and 300 total per 15 minutes, keyed on IP, in a country where mobile carriers put whole subscriber pools behind one address. The tighter budget is the one that bites: twenty sign-ins per carrier NAT per quarter hour is an outage, not a control. | The fix is to key the auth budget on the phone number being attempted as well as the IP, which is also what FR-2.3's per-account lockout needs (P-15) — one counter, two consumers. Doing it before that lockout exists would build half of it twice. |
| P-13 | Day 3 | **Registration has a timing oracle.** A free number does two INSERTs, a taken one a failed INSERT: means 56.8 ms against 46.8 ms, minima fully separated, 60% classification accuracy. | FR-1.5 exists so an attacker cannot walk a number range and learn who banks here. With real customers that list has value, and the control is currently satisfied for body and status only. Login's version was closed by making the write unconditional; registration has no such lever, so closing it means padding responses to a fixed budget — a decision that touches every write path and should be made once. |
| P-28 | F1 | **S-5's timing assertion is flaky under load.** `auth.test.ts` compares two medians and requires the ratio below 1.5. On a loaded machine it measured 5.8 ms against 9.4 ms — ratio 1.615 — and failed; three consecutive runs on an idle machine passed. At single-digit milliseconds the scheduler is louder than the signal. | Not a broken control, and that is what makes it dangerous: a test that cries wolf gets quarantined, and this one guards a real finding — the login path was measurably distinguishable before it was fixed. The repair is statistical rather than a wider threshold: more samples, a warm-up, and comparing distributions instead of two medians. Parked rather than patched because loosening the number is the one change that would keep it green while removing what it detects. |
| P-17 | Day 3 | **The DB-backed suites clean up nothing and can skip silently.** No teardown; the database has reached 1 837 accounts, 2 138 ledger entries and 1 280 transfers; `uniquePhone()` collision probability grows monotonically; `describe.skipIf(!hasDatabase)` removes thirty-plus tests and still reports green. | It fails open, not closed. **Second demonstration:** an I-4 drift of 2 300 000 tiyin accumulated in that shared database and persisted across every subsequent run, turning four tests red on unmutated code. CI never saw it — each run gets a fresh Postgres container — so the only environment that keeps state is the one with no reset. Needs one decision, transaction rollback or a schema per run or truncation, before more suites are built on the current shape. |

---

## Tier C — quality and maintenance

| # | Raised | Gap | Why it can wait |
|---|---|---|---|
| P-5 | Day 2 | CI actions are mutable tags, not SHAs; no `permissions:` block; no `timeout-minutes`; only Node 22 is exercised although `engines` allows `^22 \|\| >=24`. | A batch of related edits to one file, worth one deliberate pass. gitleaks was added pinned by digest at T-6.4, so the pattern to follow is already there. |
| P-3 | Day 2 | CI pins Postgres by floating tag (`postgres:17-alpine`), so a green run is not reproducible months later. | One line, and it belongs with P-5. |
| P-19 | Day 5 | **No `AccountService`.** §8.3 puts balance, history and lookup in the domain; `routes/accounts.ts` and `routes/recipients.ts` query Prisma directly, and FR-4.9's cap lives in the route. | Mechanical, but it should happen when B6 defines what the USSD channel needs from lookup — the whole point of the service is one implementation for two consumers, and building it against one is guessing at the other. |
| P-10 | Day 2 | `noRestrictedImports` is not wired, so §8.2's one-way dependency rule is held by review. Behaviourally obeyed today. | Needs `apps/web` to have code — one workspace cannot import another that is empty. |
| P-12 | Day 2 | Spec ER drift: §9.1 shows `USER ||--|| ACCOUNT` while the schema allows one account per currency, and `TRANSFER \|o--\|\| IDEMPOTENCY_RECORD` is not modeled. | The schema is the more useful shape; amend the diagram as part of a spec pass. Overlaps with P-8, which changes the same table. |
| P-18 | Day 4 | FR-4.7's maximum and FR-6.1's WEB per-operation limit are the same number, so `limit.per_operation` is unreachable on the web channel. | A product question about fraud exposure, not an implementation one. Recorded so nobody "fixes" the ordering and expects different behaviour. |

---

## Beyond the code

Closing every entry above still would not make this a product that handles real
money. Recorded here so the list is not mistaken for a complete one:

- **A licence and a legal entity.** §A.5 is explicit: a real integration with
  Payme, Click or Uzum requires a contract and a registered company.
- **KYC and AML.** §3 lists them as frozen non-goals. A product cannot.
- **Monitoring and alerting.** `fatal` reaches a log stream; nothing pages
  anyone. The reconciliation job exits non-zero and nothing watches it.
- **Backup and recovery policy.** A ledger needs a retention decision and a
  tested restore, not whatever the hosting tier defaults to.
- **An incident runbook.** What to do when reconciliation fails is currently
  "someone has to look", which is not a procedure.

---

## Closed

| # | Raised | Gap | Resolution |
|---|---|---|---|
| P-1 | Day 2 | §12.3 had no code for a request that reached no route, an unparseable body, or an oversized one — all three left the API as HTML or as a *retryable* `INTERNAL 500`. | `NOT_FOUND`, `MALFORMED_BODY` and `PAYLOAD_TOO_LARGE` added to the catalog and to `packages/shared`, with a terminal 404 handler and body-parser mapping. |
| P-6 | Day 2 | gitleaks was named by the spec three times and existed nowhere. | Added to CI pinned by image **digest**. It found two matches on its first run: the `.env.example` placeholder, allowlisted by path with the reason written down, and a hard-coded test secret, which was removed rather than allowlisted. The historical commit is allowed by SHA, so a real secret in that same file tomorrow still fails. |
| P-7 | Day 2 | Coverage was an aspiration with no instrument. | Measured and gated in both workspaces. The domain clears 90% on lines, statements and functions; branches sit at a measured floor with the reason recorded rather than the number quietly lowered. `packages/shared` went from 31% to 97% once it had its own tests — which is a large part of why two masking bugs had shipped. |
| P-9 | Day 2 | §12.2 mandated a 400 for a missing `Idempotency-Key` and §12.3 had no code for it. | Resolved as `VALIDATION_ERROR` with `path: ["Idempotency-Key"], code: "field.required"`, on both money endpoints, each with a test. |
| P-14 | Day 3 | **`SameSite=Strict` and the §20.1 topology could not both hold.** Vercel and Render are separate registrable domains, both on the Public Suffix List, so the refresh cookie could never attach — invisibly, because supertest and local development each use one host. | Closed by ADR-0009: the API is served through the web origin with a Vercel rewrite, so `/api` is same-origin and FR-2.4 stands unamended. Two consequences handled with it — CDN caching disabled in `vercel.json` *and* `Cache-Control: no-store` from the API, because a cached balance is one user's shown to another; and the proxy chain gained a hop, which is why P-11 now blocks on the production smoke test rather than on a test topology. |
| P-20 | Day 5 | FR-4.9's lookup cap keyed on `userId`, and identities were free at ~54 ms each. | Registration and login now carry a 20-per-15-minutes budget per IP on top of the global 300, so the per-user counter has something scarce to count. The residual is P-11, which is why that entry moved to Tier A. |
