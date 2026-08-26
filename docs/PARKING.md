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
| P-4 | Day 2 | **The API connects as a superuser that owns its own tables.** The append-only trigger, the treasury guard and the balance constraints all hold against ordinary DML, and none survives `ALTER TABLE … DISABLE TRIGGER`, `CREATE OR REPLACE FUNCTION`, or `session_replication_role = replica`. | The ledger's guarantees are the product. A compromised application process — the most likely thing to be compromised — can currently rewrite them, which is why the migration header claims only that "a bug in service code cannot corrupt the ledger", not that nothing can. Closing it is a runtime role that owns nothing and holds only `SELECT`/`INSERT`/`UPDATE` on the tables it needs. Needs the hosted database (T-2.6). |
| P-14 | Day 3 | **`SameSite=Strict` and the §20.1 topology cannot both hold.** The PWA on Vercel and the API on Render are two registrable domains, both on the Public Suffix List, so no cookie domain bridges them and the browser will not attach the refresh cookie cross-site. | A **functional** blocker, not only a security one: refresh passes every test here and fails on the first real deploy, so every session dies after fifteen minutes with no way to renew. Two resolutions — put the API behind the web origin's path so the cookie is same-site, or move to `SameSite=Lax` plus an explicit CSRF token and amend FR-2.4. The first is cheaper and strictly stronger. |
| P-15 | Day 3 | **FR-2.3 lockout is not implemented.** `AuthAttempt` rows are written but nothing counts them; `AUTH_LOCKED` exists in the catalog, the status map and a test, for a code the application can never emit. `Retry-After` appears nowhere. | With real accounts this is account-takeover exposure, not a missing feature. The IP rate limit added at T-6.4 raises the cost of bombardment but does not bound attempts *per account*, which is what FR-2.3 specifies and what a shared NAT or a botnet defeats. The rows have been written since day 3 precisely so the counter has history when it lands. |
| P-16 | Day 3 | **Access tokens outlive revocation by up to fifteen minutes**, including the attacker's, because a JWT is self-contained and there is no revocation list. | Reuse detection exists to end a stolen session (FR-2.7). Ending it fifteen minutes later, on endpoints that move money, is most of the way to not ending it. A `tokensValidAfter` timestamp checked on the money endpoints closes it, and those endpoints now exist. |
| P-8 | Day 2 | **Idempotency keys share one global namespace.** `idempotency_records.key` is the sole primary key, so one user can pre-claim a key another will use and turn their transfer into a `409`. `transfers.idempotencyKey` has the same shape independently. | A cross-tenant denial of service on the money path. Unguessable UUIDs make it impractical *today*, which is a statement about clients we do not control — a buggy or hostile client that reuses a fixed key breaks other people's payments. `@@id([userId, key])` fixes it and deviates from §9.1's ER diagram, so the spec changes with it. |
| P-11 | Day 2 | **`trust proxy` is asserted only in a comment.** Off the load balancer, `req.ip` and `req.secure` are client-controlled, because the single hop being trusted is then the caller. | This moved from theoretical to load-bearing at T-6.4: every rate limit now keys on `req.ip`, so a forged header makes all of them advisory — including the registration cap that P-20's closure depends on. Needs a test pinning the behaviour in both topologies, and a decision about what to trust when the deployment is not behind exactly one proxy. |

---

## Tier B — blocks running unattended, or at more than one instance

| # | Raised | Gap | Why it is B |
|---|---|---|---|
| P-22 | Day 6 | **Rate limiting and the lookup counter are in-process.** `express-rate-limit`'s default store and the `Map` in `routes/recipients.ts` both live in one Node process, so the limits are per-instance and reset on restart. | Render's free tier runs one instance, so this is correct *today* and wrong the moment there are two — the effective limit silently multiplies by the instance count. It also resets on every deploy and every cold start (§20.3), which is a scheduled bypass rather than an edge case. A shared store is the fix, and it should move both counters at once. |
| P-2 | Day 2 | **`Account.balance` can drift from `sum(ledger)` with nothing detecting it in real time.** I-4 is a daily job (§20.4), so a drift at 09:00 is invisible until the next run. | A day of wrong balances is a day of real users deciding on a wrong number, and by then the transfers built on it have happened too. The options are to have the trigger maintain `balance` rather than trust the writer, or to assert it at COMMIT. Now decidable: `TransferService` exists, so this is no longer guessing at a write model that has not been written. |
| P-21 | Day 5 | **`balanceAfter` is validated by nothing** — not the CHECK, not `assert_transfer_balanced`, not `reconcile`. §9.2 sells the column as making an audit O(1); that audit can be silently wrong while I-1 and I-4 both report green. | Same family as P-2 and should be decided with it. An untrustworthy audit trail is worse than none, because a reconciliation built on it reads from the corrupted source it is meant to police. |
| P-13 | Day 3 | **Registration has a timing oracle.** A free number does two INSERTs, a taken one a failed INSERT: means 56.8 ms against 46.8 ms, minima fully separated, 60% classification accuracy. | FR-1.5 exists so an attacker cannot walk a number range and learn who banks here. With real customers that list has value, and the control is currently satisfied for body and status only. Login's version was closed by making the write unconditional; registration has no such lever, so closing it means padding responses to a fixed budget — a decision that touches every write path and should be made once. |
| P-17 | Day 3 | **The DB-backed suites clean up nothing and can skip silently.** No teardown; `uniquePhone()` collision probability grows monotonically; `describe.skipIf(!hasDatabase)` removes thirty-plus tests and still reports green. | It fails open, not closed. A release gate that can quietly stop testing is not a gate, and the day-5 review demonstrated the shared-state half by poisoning the database for four runs. Needs one decision — transaction rollback, a schema per run, or truncation — before more suites are built on the current shape. |

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
| P-20 | Day 5 | FR-4.9's lookup cap keyed on `userId`, and identities were free at ~54 ms each. | Registration and login now carry a 20-per-15-minutes budget per IP on top of the global 300, so the per-user counter has something scarce to count. The residual is P-11, which is why that entry moved to Tier A. |
