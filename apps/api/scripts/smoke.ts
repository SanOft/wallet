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
  return { status: res.status, body }
}

async function main(): Promise<void> {
  console.log(`smoke: ${BASE}`)

  // 1 — the service and its database.
  const health = await call("/health")
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
  report("POST /api/auth/register", register.status === 201, `status=${register.status}`)

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
  report(
    "POST /api/auth/register (recipient)",
    recipient.status === 201,
    `status=${recipient.status}`,
  )

  // 3 — it can authenticate.
  const login = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: senderPhone, password: senderPassword }),
  })
  const token = String(login.body.accessToken ?? "")
  report("POST /api/auth/login", login.status === 200 && token.length > 0, `status=${login.status}`)

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
  report("POST /api/accounts/topup", topUp.status === 201, `status=${topUp.status}`)

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

  console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error("smoke: threw before finishing —", error instanceof Error ? error.message : error)
  process.exit(1)
})
