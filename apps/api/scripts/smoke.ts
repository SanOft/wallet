/**
 * Production smoke test (runbook T-6.3).
 *
 * Exercises the paths that would make a deploy worthless if broken: the service
 * is up, an identity can be created, it can authenticate, and money can move.
 * Anything less is a check that the process started, which the platform already
 * knows.
 *
 * No dependencies and no test runner — this runs against a deployed URL from a
 * workflow step, so it uses Node's own `fetch` and exits non-zero on the first
 * failure. It deliberately does not import from `src/`: a smoke test that
 * shares code with the thing it tests can pass because both are wrong the same
 * way.
 *
 * It writes to the production database. Every run leaves two accounts behind,
 * named so they are recognisable, and that accumulation is tracked rather than
 * hidden — see P-26.
 */

const BASE = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "")
const EXPECTED_VERSION = process.env.SMOKE_EXPECTED_VERSION ?? ""

if (!BASE) {
  console.error("SMOKE_BASE_URL is required, e.g. https://wallet.example.com")
  process.exit(2)
}

let failures = 0

function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/** Names the difference between a broken endpoint and an absent instance. */
function describe(result: Result): string {
  if (result.routing) return `status=${result.status} platform=${result.routing}`
  return `status=${result.status}`
}

/** A number no real user holds: the +998 33 range is unassigned to carriers. */
function smokePhone(): string {
  const suffix = String(Math.floor(1_000_000 + Math.random() * 8_999_999))
  return `+99833${suffix}`
}

function password(): string {
  return `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

interface Result {
  status: number
  body: Record<string, unknown>
  /** Present only when our own service answered; the edge does not set it. */
  requestId: string | null
  /** Render sets this when it has no instance to route to. */
  routing: string | null
}

/**
 * The daily allowance out of an accounts response, or `null` if it is not
 * there in the shape the contract promises.
 *
 * Read by hand rather than with `accountsResponseSchema`, for the reason at the
 * top of this file: the API validates its own responses against that schema, so
 * a smoke test using it would agree with a broken server about what "valid"
 * means. A malformed or absent field returns `null` here, which fails the
 * check — the direction an unknown shape should fail in.
 */
function readDaily(
  body: Record<string, unknown>,
): Record<"limit" | "spent" | "remaining", string> | null {
  const limits = body.limits
  if (typeof limits !== "object" || limits === null) return null

  const daily = (limits as Record<string, unknown>).daily
  if (typeof daily !== "object" || daily === null) return null

  const fields = daily as Record<string, unknown>
  const limit = fields.limit
  const spent = fields.spent
  const remaining = fields.remaining
  if (typeof limit !== "string" || typeof spent !== "string" || typeof remaining !== "string") {
    return null
  }

  return { limit, spent, remaining }
}

async function call(
  path: string,
  init: RequestInit & { token?: string; key?: string } = {},
): Promise<Result> {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  if (init.token) headers.set("authorization", `Bearer ${init.token}`)
  if (init.key) headers.set("idempotency-key", init.key)

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return {
    status: res.status,
    body,
    requestId: res.headers.get("x-request-id"),
    routing: res.headers.get("x-render-routing"),
  }
}

/**
 * Up to six attempts over roughly a minute. Only the readiness check uses this:
 * a transfer that fails is a real failure, and retrying it would both hide the
 * fault and move money twice.
 */
async function withRetries(
  attempt: () => Promise<Result>,
  ok: (result: Result) => boolean,
): Promise<Result> {
  let last: Result = { status: 0, body: {}, requestId: null, routing: null }
  for (let i = 1; i <= 6; i++) {
    try {
      last = await attempt()
      if (ok(last)) return last
      console.log(`  waking: attempt ${i} gave ${last.status}`)
    } catch (error) {
      console.log(`  waking: attempt ${i} threw ${error instanceof Error ? error.message : ""}`)
    }
    if (i < 6) await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  return last
}

async function main(): Promise<void> {
  console.log(`smoke: ${BASE}`)

  // 1 — the service and its database.
  //
  // Retried, because both tiers this runs against sleep. Neon scales its
  // compute to zero and Render's free instance idles out, so the first
  // connection after a quiet period is spent waking something up and is
  // dropped — observed as `Connection terminated unexpectedly` while setting
  // the database up by hand. A single attempt here would report a healthy
  // deployment as broken.
  const health = await withRetries(
    () => call("/health"),
    (r) => r.status === 200,
  )
  const version = String(health.body.version ?? "")
  report(
    "GET /health",
    health.status === 200 && health.body.db === "up",
    `status=${health.status} db=${String(health.body.db)} version=${version.slice(0, 7)}`,
  )
  if (EXPECTED_VERSION && version !== EXPECTED_VERSION) {
    report(
      "deployed commit",
      false,
      `serving ${version.slice(0, 7)}, expected ${EXPECTED_VERSION.slice(0, 7)}`,
    )
  }

  // 2 — an identity can be created. Two of them: a transfer needs a recipient.
  const senderPhone = smokePhone()
  const senderPassword = password()
  const register = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      phone: senderPhone,
      firstName: "Smoke",
      lastName: "Test",
      password: senderPassword,
    }),
  })
  report("POST /api/auth/register", register.status === 201, describe(register))

  const recipientPhone = smokePhone()
  const recipient = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      phone: recipientPhone,
      firstName: "Smoke",
      lastName: "Recipient",
      password: password(),
    }),
  })
  report("POST /api/auth/register (recipient)", recipient.status === 201, describe(recipient))

  // 3 — it can authenticate.
  const login = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: senderPhone, password: senderPassword }),
  })
  const token = String(login.body.accessToken ?? "")
  report("POST /api/auth/login", login.status === 200 && token.length > 0, describe(login))

  if (!token) {
    console.error("no access token — the remaining checks cannot run")
    process.exit(1)
  }

  // 4 — money moves. A transfer needs funds, so the demo mint comes first;
  // its failure is reported separately so a spent daily allowance (FR-10.3)
  // is not mistaken for a broken transfer path.
  const topUp = await call("/api/accounts/topup", {
    method: "POST",
    token,
    key: crypto.randomUUID(),
    body: JSON.stringify({}),
  })
  report("POST /api/accounts/topup", topUp.status === 201, describe(topUp))

  const transfer = await call("/api/transfers", {
    method: "POST",
    token,
    key: crypto.randomUUID(),
    body: JSON.stringify({ phone: recipientPhone, amount: "300000" }),
  })
  const completed = transfer.status === 201 && transfer.body.status === "COMPLETED"
  report(
    "POST /api/transfers",
    completed,
    `status=${transfer.status} outcome=${String(transfer.body.status ?? transfer.body.error)}`,
  )

  /*
   * The accounts response, read *after* the transfer so the daily allowance
   * has something to report.
   *
   * A shape check alone would pass against a hardcoded number, so this asserts
   * the arithmetic instead: the account was registered moments ago, so the one
   * transfer above is the whole of its rolling 24 hours (FR-6.1) and `spent`
   * has exactly one correct value. That is the difference between "the field
   * is present in production" and "the figure production serves is computed
   * from what actually happened" — the second is what P-32 promised, and the
   * only place the deployed build is exercised.
   *
   * No extra pollution: it reuses the session the checks above already made,
   * and reads rather than writes (P-26).
   */
  const accounts = await call("/api/accounts", { token })
  const daily = readDaily(accounts.body)
  const allowanceCorrect =
    accounts.status === 200 &&
    daily !== null &&
    daily.spent === "300000" &&
    BigInt(daily.remaining) === BigInt(daily.limit) - 300_000n
  report(
    "GET /api/accounts — daily allowance tracks the transfer",
    allowanceCorrect,
    `status=${accounts.status} spent=${String(daily?.spent)} remaining=${String(daily?.remaining)} limit=${String(daily?.limit)}`,
  )

  console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error("smoke: threw before finishing —", error instanceof Error ? error.message : error)
  process.exit(1)
})
