# Next session — where this stands and what to do

A handoff, not a design. Written for a fresh session in a fresh terminal that
has none of the preceding conversation.

Every number here was measured on the run that produced this file, not
remembered. Where something is unverified it says so.

---

## 0. Check what is unmerged before doing anything

```bash
gh pr list --state open
git log --oneline origin/main -3
```

A session that starts by writing code on top of `main` while two reviewed
branches sit unmerged will conflict with itself. If anything is open, land it
first — the checks are already green or the PR says why they are not.

This document was written alongside such a set, so treat a non-empty list as
normal rather than as a sign something went wrong.

---

## 1. Bootstrap the terminal

The database is a container and does not survive a reboot. Symptom when it is
down: `ECONNREFUSED 127.0.0.1:5434` from any suite that touches Postgres, which
is most of the API suite.

```bash
cd C:/Users/Abdulloh/projects/wallet-pwa/wallet
docker compose up -d          # wallet-postgres-1 → 127.0.0.1:5434
yarn verify                   # lint && build && typecheck && test
```

Last green run on `main` as this was written: **351 API + 62 shared + 308 web =
721**. The figure moves with every PR, so treat a mismatch as staleness in this
line rather than as a missing test — and re-derive it from your own run instead
of trusting it.

`yarn verify` is defined in the root `package.json` and chains with `&&`, so a
non-zero exit is real. **Read the exit code — do not read the harness's.** A
command written as `yarn verify > log 2>&1; echo "EXIT=$?"` reports the exit of
the `echo`. This has produced a false green twice.

Two long-running servers are expected to stay up for smoke testing:

```bash
yarn workspace @wallet/web dev     # localhost:5173
yarn workspace @wallet/api dev     # localhost:3000
```

Permanent test accounts: Sanjar Juraev `+998884615500`, Amina Jurayeva
`+998884625500`.

---

## 2. What the code is waiting on — and it is not code

Six items are open in `docs/PARKING.md`. **All six need a decision or an
action outside this repository.** No amount of implementation closes them, and
a session that goes looking for code to write against them will invent scope.

| # | What it needs | Whose | Unblocks |
|---|---|---|---|
| P-11 | Set `TRUST_PROXY_HOPS=3` on Render | Operator | Correct rate-limit keying |
| P-4 | Run `apps/api/prisma/runtime-role.sql` on Neon, repoint `DATABASE_URL` | Operator | The ledger's guarantees against a compromised process |
| — | Set `apps/web/vercel.json:6` to the Render URL | Operator | Production E2E, P-23's residual, load testing |
| P-18 | Decide: should the web per-operation cap sit below FR-4.7's maximum? | Product | Nothing; it is a fraud-exposure judgement |
| P-22 | A shared limiter store | Platform | Correctness at more than one instance |
| P-27 | A non-sleeping instance | Platform | First-request availability |

### P-11 is the cheapest and production already answered it

`/health` reports `proxyChain` and `trustedHops`. The last deployment read
`proxyChain=3 trustedHops=1`. The value to set is **3**. One environment
variable, no deploy of code.

### P-4's exact steps are already written

`docs/runbook.md` §T-6.1, under **The runtime role**. Summary: connect to Neon
as the owner, run `apps/api/prisma/runtime-role.sql` with `__PASSWORD__`
replaced by a generated secret, then point `DATABASE_URL` at `wallet_runtime`
in three places — `.env.neon`, the Render environment, and the two GitHub
Actions secrets. `DATABASE_URL_UNPOOLED` keeps naming the owner, because
migrations create and alter and the runtime role deliberately cannot. Rotate
`wallet_owner` in the same pass; the file is idempotent and re-running it is
how the password rotates.

**The deployment now tells you whether this has been done.** The API logs at
boot: `db.over_privileged` at `warn` while it still connects as the owner, or
`db.least_privilege` at `info` once it does not. Do not take a green deploy as
evidence — read that line.

---

## 3. The one substantial thing that is *not* blocked

**There is no end-to-end suite. `playwright` appears in no `package.json` and
no config file in this repository.**

This was previously filed as blocked on the Vercel origin. That is only true of
E2E *against production*. A local suite needs `localhost:5173` and
`localhost:3000`, both of which run today, and it is the largest remaining body
of work that needs nobody's permission.

What it should cover, and nothing more — the journeys the component tests
cannot reach because they cross pages:

1. Register → land on the wallet → see a zero balance.
2. Demo top-up → balance updates → the entry appears in history.
3. Transfer to the second test account → both balances move → both histories agree.
4. Sign out → the access token is gone from memory → a protected route redirects.
5. Offline: queue a transfer with the network down, restore it, watch the outbox drain.

Rules that apply (from `qa-engineering`, and from what this repo already does):

- Locator priority is role, then label, then text. `data-testid` last.
- Synchronise on a signal — a locator state, a response, a URL. Never
  `waitForTimeout`.
- Do not repeat what a component test already covers. Five journeys, not fifty.
- A setup project plus `storageState` for auth, not `globalSetup` — `globalSetup`
  loses traces and report visibility.
- Baselines are generated where they are compared. A laptop baseline diffed in
  Linux CI is a guaranteed mismatch, not a regression.

Scope check before starting: this is L3 under the gate system (new dependency,
new CI job, 3+ files). **It needs approval before code**, per GATE 2 and the
dependency-discipline rule — resolve `@playwright/test` against the installed
Vite 8 / React 19 versions from the lockfile and run `yarn audit` first.

---

## 4. Traps this project has already walked into

Not general advice. Each of these happened here, and each cost a rework.

**A test that cannot fail looks exactly like one that passes.** Six false greens
so far, every one caught by an explicit control rather than by coverage:
`globalRateLimit()` rebuilt its store per request so the limit never fired; five
privilege assertions passed on a connection error (`28P01`) instead of a refusal
(`42501`); a contrast regex carried a literal backspace byte; the layer guard
stripped string literals, disabling three of its four rules; a deploy monitor
reported a different commit's run, three times; `accountForPhone`'s `type`
guard had zero coverage and deleting it let money reach the treasury's phone
number. **Every new guard gets a control that fails when the guard stops
checking.** This is runbook §5's third standing rule.

**Never write a regex through a heredoc.** `\b` became a literal backspace byte
twice, through both Python and bash heredocs. Use the Write or Edit tool for
anything containing a backslash.

**"Blocked" has been the wrong judgement four times** — P-4, P-33, P-11, P-18.
In each case the entry's hardest sentence hid two separable jobs, one of which
was doable immediately. Before accepting a blocked item, ask what half of it
can be proved, measured, or made self-reporting today. P-11 got its answer by
making `/health` report the number; P-4 by making the boot log say which role it
connected as.

**Do not conclude causation from one observation per arm.** Done twice. Both
times the effect was machine load.

**Never restore files with `git checkout --` during mutation testing.** Use file
backups. The auto-mode classifier blocks the former anyway.

**`pre-bash-guard.sh` blocks pushes to protected branches and reads `git push -q -u`
as a force push.** Push in a separate call: `git push origin HEAD`. Do not
bypass the guard.

**`secret-scan.sh` blocks password-shaped literals.** Assemble test secrets with
`.join("-")`.

---

## 5. Standing rules for the work itself

From `CLAUDE.md`, restated here because they decide what "done" means:

- Calibration is **Strong Senior + Staff**. Implementation is idiomatic and
  cites the pattern it follows; architecture names the trade-off, the
  reversibility class, and the rejected alternatives.
- **Evidence only.** No claim about this project without a `path:line`. Comments
  and READMEs are not evidence; a contradiction between code and comment is
  itself a finding.
- **No fabricated metrics.** Every count, size, and coverage figure comes from a
  command that was actually run.
- **Scope contract is law.** A discovered need for a wider refactor becomes a
  PARKING entry, never an unrequested diff.
- **Errors are never passed over in silence.** If something is unverified, the
  output says which thing and what would falsify it.
- **Never credit any model** in a commit, PR, issue, review comment, or code
  comment. The author is the user.

Quality bars that are not negotiable: the Lighthouse budget in `docs/spec.md`
NFR-2.1, which CI now enforces; lucide-react for icons; full screen-reader
support; low-bandwidth first.

This line used to say "all four Lighthouse categories ≥ 98". Measured, that was
never true of mobile Performance and is not a bar a CI gate can hold — thirty
samples put it at 97–98, and the 98 in the runbook was a single draw from a
two-valued number. Accessibility, best practices and SEO are now held at
exactly 100, which is stricter than the sentence it replaces; mobile
Performance is held by metric ceilings with a ≥ 95 backstop.

---

## 6. How to tell the project is finished

Not "tests pass". The gates, in order:

1. `yarn verify` green, exit code read directly.
2. The deploy log says `db.least_privilege`, not `db.over_privileged`.
3. `/health` on the production origin reports `trustedHops` equal to
   `proxyChain`.
4. `apps/web/vercel.json` contains no `.invalid` hostname.
5. `docs/PARKING.md` Tier A is empty.
6. The five journeys in §3 pass against a real browser.
7. A Lighthouse run on the deployed origin meets `docs/spec.md` NFR-2.1, with
   the report kept. CI holds that budget against a local production build on
   every pull request; what a deployed origin adds is the CDN, the real
   network and TLS, which is why this gate stays separate from the CI one.

Items 2–4 and 7 cannot be reached from this repository alone.
