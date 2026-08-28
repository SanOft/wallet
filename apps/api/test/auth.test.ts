import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { publicUserSchema } from "@wallet/shared"
import { SignJWT } from "jose"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { REFRESH_COOKIE, SESSION_HINT_COOKIE } from "../src/adapters/http/cookies.js"
import { attemptSubject, hashRefreshToken, hashSecret, verifySecret } from "../src/infra/crypto.js"
import { createTokenService } from "../src/infra/jwt.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv } from "./helpers.js"

const hasDatabase = Boolean(process.env.DATABASE_URL)

/** Fifteen characters minimum (FR-1.2); these are throwaway strings. */
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

function uniquePhone(): string {
  // +998 90 then seven digits, so each run gets a number of its own.
  return `+99890${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
}

function registration(phone = uniquePhone()) {
  return { phone, firstName: "Alisher", lastName: "Navoiy", password: PASSWORD }
}

describe("password hashing (NFR-1.1, FR-1.3)", () => {
  it("uses the OWASP parameters, read back from the digest itself", async () => {
    const digest = await hashSecret(PASSWORD)

    // Asserting against the constants the code passes would prove nothing; the
    // PHC string is what a future reader can verify independently.
    expect(digest).toMatch(/^\$argon2id\$v=19\$/)
    expect(digest).toContain("m=19456")
    expect(digest).toContain("t=2")
    expect(digest).toContain("p=1")
  })

  it("verifies the right secret and rejects the wrong one", async () => {
    const digest = await hashSecret(PASSWORD)
    expect(await verifySecret(digest, PASSWORD)).toBe(true)
    expect(await verifySecret(digest, `${PASSWORD}x`)).toBe(false)
  })

  it("returns false rather than throwing on a malformed digest", async () => {
    // The SYSTEM account's sentinel is exactly this shape (§9.4). A throw here
    // would turn a login attempt against it into a 500 that says "interesting".
    expect(await verifySecret("!system-account-cannot-authenticate!", PASSWORD)).toBe(false)
  })
})

describe("access tokens (FR-2.4, FR-2.5)", () => {
  const env = testEnv()
  const tokens = createTokenService(env)
  const secret = new TextEncoder().encode(env.JWT_SECRET)

  it("round-trips a subject, and reports when the token was minted", async () => {
    const userId = randomUUID()
    const before = Math.floor(Date.now() / 1000)
    const claims = await tokens.verify(await tokens.sign({ userId }))

    expect(claims?.userId).toBe(userId)
    // `issuedAt` is what `requireCurrentSession` compares against
    // `tokensValidAfter` (P-16), and it comes from the signature rather than
    // from the caller — a client-supplied value would be the revocation list
    // letting the attacker write to it.
    expect(claims?.issuedAt).toBeGreaterThanOrEqual(before)
    expect(claims?.issuedAt).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000))
  })

  it("refuses a token with no issued-at claim", async () => {
    // Without `iat` there is nothing to compare, and treating that as "new
    // enough" would let a hand-rolled token skip the revocation check.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setIssuer("wallet-api")
      .setAudience("wallet-client")
      .setExpirationTime("15m")
      .sign(secret)

    expect(await tokens.verify(forged)).toBeNull()
  })

  it("expires in fifteen minutes, measured from the token's own claims", async () => {
    const token = await tokens.sign({ userId: randomUUID() })
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      iat: number
      exp: number
    }

    // FR-2.4. Read from the signed payload, not from the constant the module
    // exports — otherwise a drift between the advertised `expiresIn` and the
    // real expiry is structurally undetectable.
    expect(claims.exp - claims.iat).toBe(900)
    expect(tokens.expiresInSeconds).toBe(claims.exp - claims.iat)
  })

  it("rejects a token signed with a different algorithm", async () => {
    // Algorithm confusion: a verifier that trusts the token's own `alg` header
    // accepts this. FR-2.5 exists to make sure ours does not.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS512" })
      .setSubject(randomUUID())
      .setIssuer("wallet-api")
      .setAudience("wallet-client")
      .setExpirationTime("15m")
      .sign(secret)

    expect(await tokens.verify(forged)).toBeNull()
  })

  it("rejects an unsigned `alg: none` token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), iss: "wallet-api", aud: "wallet-client" }),
    ).toString("base64url")

    expect(await tokens.verify(`${header}.${payload}.`)).toBeNull()
  })

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setIssuer("wallet-api")
      .setAudience("wallet-client")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret)

    expect(await tokens.verify(expired)).toBeNull()
  })

  it("rejects a token minted for a different audience", async () => {
    const other = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setIssuer("wallet-api")
      .setAudience("some-other-service")
      .setExpirationTime("15m")
      .sign(secret)

    expect(await tokens.verify(other)).toBeNull()
  })
})

describe.skipIf(!hasDatabase)("registration (FR-1)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("opens one UZS account with a zero balance", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const body = registration()

    const res = await request(app).post("/api/auth/register").send(body)

    expect(res.status).toBe(201)
    expect(res.body.user.phone).toBe(body.phone)
    expect(res.body.expiresIn).toBe(900)

    const accounts = await prisma.account.findMany({ where: { user: { phone: body.phone } } })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.currency).toBe("UZS")
    expect(accounts[0]?.balance).toBe(0n)
    expect(accounts[0]?.type).toBe("USER")
  })

  it("never puts a password hash on the wire", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app).post("/api/auth/register").send(registration())

    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain("passwordHash")
    expect(wire).not.toContain("$argon2")
    expect(wire).not.toContain(PASSWORD)
    // The response is exactly the public shape and nothing else.
    expect(publicUserSchema.strict().safeParse(res.body.user).success).toBe(true)
  })

  it("keeps the refresh token out of the body and in an httpOnly cookie (FR-2.4)", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app).post("/api/auth/register").send(registration())

    const cookie = res.headers["set-cookie"]?.[0] ?? ""
    expect(cookie).toContain(REFRESH_COOKIE)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    // Scoped to the only prefix that needs it, so it is not attached to every
    // request the browser makes.
    expect(cookie).toMatch(/Path=\/api\/auth/i)
    // No TLS on localhost, so `Secure` would make the browser drop it.
    expect(cookie).not.toMatch(/Secure/i)
    expect(Object.keys(res.body)).toEqual(["accessToken", "expiresIn", "user"])
  })

  /**
   * Every `Set-Cookie`, as a list.
   *
   * Node types the header as `string | string[]` because HTTP allows either,
   * and a response that happens to carry one cookie would otherwise be
   * iterated a character at a time — a failure that reads as "the cookie is
   * missing".
   */
  function setCookies(res: { headers: Record<string, unknown> }): string[] {
    const raw = res.headers["set-cookie"]
    if (Array.isArray(raw)) return raw as string[]
    return typeof raw === "string" ? [raw] : []
  }

  it("sets a readable hint beside it, carrying nothing", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app).post("/api/auth/register").send(registration())

    const hint = setCookies(res).find((value) => value.startsWith(`${SESSION_HINT_COOKIE}=`)) ?? ""

    expect(hint).not.toBe("")
    /*
     * Readable on purpose. The refresh cookie is `httpOnly`, so a client had
     * no way to tell "signed out" from "signed in" without asking and being
     * refused — a guaranteed 401 on every anonymous page load.
     */
    expect(hint).not.toMatch(/HttpOnly/i)
    // Readable on the app's own pages, not only under /api/auth.
    expect(hint).toMatch(/Path=\//i)
    expect(hint).toMatch(/SameSite=Strict/i)

    // It says "1" and nothing else. Anything derived from the token would make
    // a readable cookie into a credential.
    expect(hint.split(";")[0]).toBe(`${SESSION_HINT_COOKIE}=1`)
    expect(hint).not.toContain(res.body.accessToken)
  })

  it("clears the hint together with the cookie on logout", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const registered = await request(app).post("/api/auth/register").send(registration())
    const cookie = registered.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""

    const out = await request(app).post("/api/auth/logout").set("cookie", cookie)
    const cleared = setCookies(out)

    /*
     * Both, or neither is any use. A hint left behind after logout sends the
     * next visit into exactly the doomed refresh call the hint exists to
     * avoid — and it would do it forever, because nothing else ever clears it.
     */
    expect(cleared.some((value) => value.startsWith(`${REFRESH_COOKIE}=`))).toBe(true)
    expect(cleared.some((value) => value.startsWith(`${SESSION_HINT_COOKIE}=`))).toBe(true)
  })

  it("marks the cookie Secure in production (FR-2.4)", async () => {
    const { app } = buildApp(prisma, {
      ...process.env,
      NODE_ENV: "production",
      CORS_ORIGINS: "https://wallet.example.com",
    })
    const res = await request(app).post("/api/auth/register").send(registration())

    expect(res.headers["set-cookie"]?.[0] ?? "").toMatch(/Secure/i)
  })

  it("answers a taken number exactly as it answers any other rejection (FR-1.5)", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const body = registration()

    const first = await request(app).post("/api/auth/register").send(body)
    expect(first.status).toBe(201)

    const second = await request(app).post("/api/auth/register").send(body)

    // No enumeration: status and body are identical to a generic failure, so
    // walking a number range tells an attacker nothing.
    expect(second.status).toBe(400)
    expect(second.body.error.code).toBe("REGISTRATION_FAILED")
    expect(JSON.stringify(second.body.error)).not.toContain(body.phone)
  })
})

describe.skipIf(!hasDatabase)("login (FR-2.2, S-5)", () => {
  let prisma: PrismaClient
  let known: ReturnType<typeof registration>

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    known = registration()
    const { app } = buildApp(prisma, { ...process.env })
    await request(app).post("/api/auth/register").send(known)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("signs in with the right password", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone: known.phone, password: known.password })

    expect(res.status).toBe(200)
    expect(res.body.user.phone).toBe(known.phone)
  })

  /**
   * Timing comparisons use the *minimum* of many samples rather than a median.
   * The minimum approximates the work with the scheduler noise removed, and
   * the bound is a ratio rather than a millisecond figure: an absolute bound
   * has to be chosen relative to one argon2 verify, so a 50ms budget fails to
   * reject an 8x separation — which is how the original version of this test
   * passed with the leak it names still present.
   *
   * The sample count and the bound are both measured rather than chosen.
   *
   * This test spent a while measuring nothing. The auth rate limit added at
   * T-6.4 — 20 per address per fifteen minutes — answered most of each batch
   * with 429 before any hashing happened, so the minimum of the batch was the
   * fastest refusal and both arms compared two identical 429s. Measured
   * directly: thirty logins from one address returned {"401": 20, "429": 10}.
   * With the limiter in the way, deleting the constant-time defence outright
   * left all 27 tests green.
   *
   * Sampling from a distinct address per request restores the measurement, and
   * the numbers become the ones `crypto.ts` describes: ~44ms per arm, against
   * ~9ms when the defence is removed. The observed floor across five runs is
   * 1.00–1.12 — two arms doing the same work, where a millisecond of jitter is
   * a 2% swing rather than the 20% it was when both were timing a refusal.
   *
   * So the bound stays at 1.5, and that is the point: it was never too tight.
   * Raising it would have been the change that keeps the test green while
   * removing what it detects (P-28). With the leak reintroduced the ratio is
   * 4.7, so 1.5 sits 1.3x above the noise and 3.1x below the signal.
   */
  const TIMING_BOUND = 1.5
  async function timingRatio(
    app: Parameters<typeof request>[0],
    a: { phone: string; password: string },
    b: { phone: string; password: string },
    samples = 15,
  ) {
    const timesA: number[] = []
    const timesB: number[] = []

    /*
     * Every sample comes from its own address.
     *
     * Without this the auth rate limit — 20 per IP per fifteen minutes, added
     * at T-6.4 — answers most of the batch with 429 before any hashing
     * happens. The minimum of the batch is then the fastest 429, so both arms
     * measure the limiter rather than the login, and the comparison is between
     * two identical refusals. Measured directly: thirty logins from one
     * address returned {"401": 20, "429": 10}.
     *
     * That is why this test stopped detecting anything. It is not a
     * hypothetical: with the limiter in place, deleting the constant-time
     * defence entirely left all 27 tests green.
     */
    let address = 0
    const from = () =>
      request(app)
        .post("/api/auth/login")
        .set(
          "x-forwarded-for",
          `10.${(++address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
        )

    /*
     * FR-2.3's backoff also has to be kept out of the way, and for the same
     * reason as the rate limit: it answers from the fourth attempt onwards
     * without hashing, so the batch goes back to timing refusals. Measured on
     * a fresh number, twenty attempts returned {"401": 3, "429": 17}.
     *
     * Cleared between samples rather than disabled, so the code under test is
     * the code that ships. Outside the timed region, and equal for both arms.
     */
    // The same secret the app under test was built with. `testEnv()` spreads
    // its overrides last, so `buildApp(prisma, { ...process.env })` uses the
    // JWT_SECRET from the environment — not the generated one — and a subject
    // computed from the wrong key silently deletes nothing.
    const pepper = testEnv({ ...process.env }).JWT_SECRET
    const subjects = [attemptSubject(a.phone, pepper), attemptSubject(b.phone, pepper)]
    const clearBackoff = () =>
      prisma.authAttempt.deleteMany({ where: { subject: { in: subjects } } })

    // Discarded. The first requests pay for lazy imports, a cold connection
    // and an unwarmed JIT, and they land in whichever arm goes first.
    for (let warmUp = 0; warmUp < 3; warmUp++) {
      await clearBackoff()
      await from().send(a)
      await from().send(b)
    }

    for (let i = 0; i < samples; i++) {
      await clearBackoff()

      // Interleaved, so a drift in machine load hits both arms equally.
      const startedA = performance.now()
      await from().send(a)
      timesA.push(performance.now() - startedA)

      const startedB = performance.now()
      await from().send(b)
      timesB.push(performance.now() - startedB)
    }

    const lo = Math.min(...timesA)
    const hi = Math.min(...timesB)
    return { a: lo, b: hi, ratio: Math.max(lo, hi) / Math.max(Math.min(lo, hi), 0.001) }
  }

  // Thirty real argon2 verifies each, by design: the measurement is the point,
  // and the default five seconds is a budget for tests that do not hash.
  it("S-5: an unknown number is indistinguishable from a wrong password", {
    timeout: 30_000,
  }, async () => {
    const { app } = buildApp(prisma, { ...process.env })

    const unknownArm = { phone: uniquePhone(), password: PASSWORD }
    const wrongArm = { phone: known.phone, password: `${PASSWORD}-wrong` }

    const first = await request(app).post("/api/auth/login").send(unknownArm)
    const second = await request(app).post("/api/auth/login").send(wrongArm)

    expect(first.status).toBe(second.status)
    const { requestId: _a, ...unknownError } = first.body.error
    const { requestId: _b, ...wrongError } = second.body.error
    expect(unknownError).toEqual(wrongError)
    expect(unknownError).toEqual({
      code: "AUTH_INVALID_CREDENTIALS",
      message: "Invalid credentials",
    })

    const { a, b, ratio } = await timingRatio(app, unknownArm, wrongArm)
    expect(
      ratio,
      `unknown ${a.toFixed(1)}ms vs wrong-password ${b.toFixed(1)}ms — ratio ${ratio.toFixed(2)}`,
    ).toBeLessThan(TIMING_BOUND)
  })

  it("the SYSTEM account is not identifiable by how fast it fails", {
    timeout: 30_000,
  }, async () => {
    // Its passwordHash is a sentinel, not a digest (§9.4). A `verify` that
    // gives up without spending the time made the treasury — the mint for all
    // demo funds — answer 3.8x faster than any other number, in one request.
    const { app } = buildApp(prisma, { ...process.env })
    await seed(prisma)

    const { a, b, ratio } = await timingRatio(
      app,
      { phone: "+998000000000", password: PASSWORD },
      { phone: uniquePhone(), password: PASSWORD },
    )

    expect(
      ratio,
      `system ${a.toFixed(1)}ms vs unknown ${b.toFixed(1)}ms — ratio ${ratio.toFixed(2)}`,
    ).toBeLessThan(TIMING_BOUND)
  })

  it("records an attempt whether or not the number is registered", async () => {
    // Writing the row only for known numbers cost one extra INSERT and made
    // registered numbers measurably slower — an enumeration oracle (§11.2).
    const { app } = buildApp(prisma, { ...process.env })
    const stranger = uniquePhone()
    // Counted for this number alone. Counting the whole table made the test
    // depend on nothing else writing an attempt between the two reads, which
    // is not a property any suite sharing a database can offer.
    const where = { subject: attemptSubject(stranger, testEnv({ ...process.env }).JWT_SECRET) }

    expect(await prisma.authAttempt.count({ where })).toBe(0)
    await request(app).post("/api/auth/login").send({ phone: stranger, password: PASSWORD })

    const rows = await prisma.authAttempt.findMany({ where })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBeNull()
    expect(rows[0]?.succeeded).toBe(false)
  })
})

describe.skipIf(!hasDatabase)("refresh rotation and reuse (FR-2.6, FR-2.7, S-4)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function signUp() {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app).post("/api/auth/register").send(registration())
    const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""
    return { app, cookie, phone: res.body.user.phone as string }
  }

  it("stores only a digest, never the token itself (§9.2)", async () => {
    const { cookie, phone } = await signUp()
    const raw = cookie.split("=")[1] ?? ""

    const rows = await prisma.refreshToken.findMany({ where: { user: { phone } } })
    expect(rows).toHaveLength(1)
    // Asserting "not equal to the raw value" would also pass for a hex encoding,
    // which is fully reversible. This pins the actual one-way function.
    expect(rows[0]?.tokenHash).toBe(hashRefreshToken(raw))
    expect(rows[0]?.tokenHash).not.toContain(raw)
  })

  it("rejects a token whose expiry has passed", async () => {
    const { app, cookie, phone } = await signUp()

    await prisma.refreshToken.updateMany({
      where: { user: { phone } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("AUTH_REFRESH_INVALID")
  })

  it("rotates: the old token stops working and a new one is issued", async () => {
    const { app, cookie } = await signUp()

    const rotated = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(rotated.status).toBe(200)

    const newCookie = rotated.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""
    expect(newCookie).not.toBe(cookie)

    const withNew = await request(app).post("/api/auth/refresh").set("cookie", newCookie)
    expect(withNew.status).toBe(200)

    // The first clause of this test's name. Without it "rotation" is only
    // "a second token was issued", which is not the same guarantee.
    const withOld = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(withOld.status).toBe(401)
  })

  it("S-4: replaying a used token revokes the entire family", async () => {
    const { app, cookie, phone } = await signUp()

    const first = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    const liveCookie = first.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""

    // The stolen copy comes back.
    const replay = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe("AUTH_REFRESH_REUSED")

    // Not just the replayed token: the legitimate device is signed out too,
    // because we cannot tell which of the two holders is the thief.
    const afterRevocation = await request(app).post("/api/auth/refresh").set("cookie", liveCookie)
    expect(afterRevocation.status).toBe(401)

    const rows = await prisma.refreshToken.findMany({ where: { user: { phone } } })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("S-4 concurrent: parallel replays of one token mint at most one session", async () => {
    const { app, cookie, phone } = await signUp()

    // The interleaving an attacker actually has: replay the stolen cookie at
    // the same moment as the victim, not after them. A read-then-write claim
    // lets both through, and reuse detection never fires.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).post("/api/auth/refresh").set("cookie", cookie)),
    )

    const accepted = results.filter((res) => res.status === 200)
    expect(
      accepted.length,
      `accepted ${accepted.length} of 4 concurrent replays`,
    ).toBeLessThanOrEqual(1)

    const rejected = results.filter((res) => res.status !== 200)
    expect(rejected.length).toBeGreaterThanOrEqual(3)
    expect(rejected.some((res) => res.body.error.code === "AUTH_REFRESH_REUSED")).toBe(true)

    // And the family is dead, so whatever session was minted is useless.
    const rows = await prisma.refreshToken.findMany({ where: { user: { phone } } })
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("logout revokes the family and clears the cookie", async () => {
    const { app, cookie, phone } = await signUp()

    const res = await request(app).post("/api/auth/logout").set("cookie", cookie)
    expect(res.status).toBe(204)

    const rows = await prisma.refreshToken.findMany({ where: { user: { phone } } })
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true)

    const reuse = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(reuse.status).toBe(401)
  })

  it("an unknown refresh token is rejected without saying why", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", `${REFRESH_COOKIE}=not-a-real-token`)

    expect(res.status).toBe(401)
    // Not AUTH_TOKEN_EXPIRED: §12.3 tells the client that one means "refresh
    // and retry", and this *is* the refresh that just failed.
    expect(res.body.error.code).toBe("AUTH_REFRESH_INVALID")
  })
})

describe.skipIf(!hasDatabase)("GET /api/me (§12.1)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("returns the public user and nothing else", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const created = await request(app).post("/api/auth/register").send(registration())

    const res = await request(app)
      .get("/api/me")
      .set("authorization", `Bearer ${created.body.accessToken}`)

    expect(res.status).toBe(200)
    expect(publicUserSchema.strict().safeParse(res.body).success).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain("$argon2")
  })

  it("refuses an absent, malformed or forged token identically", async () => {
    const { app } = buildApp(prisma, { ...process.env })

    for (const header of [undefined, "Bearer", "Bearer not.a.token", "Basic abc"]) {
      const req = request(app).get("/api/me")
      const res = await (header ? req.set("authorization", header) : req)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe("AUTH_TOKEN_EXPIRED")
    }
  })
})

describe.skipIf(!hasDatabase)("FR-2.3 — per-account backoff", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  const PEPPER = () => testEnv({ ...process.env }).JWT_SECRET

  function app() {
    return buildApp(prisma, { ...process.env }).app
  }

  /** Distinct addresses, so the IP rate limit never answers instead. */
  let address = 0
  function attempt(instance: ReturnType<typeof app>, phone: string, password: string) {
    address += 1
    return request(instance)
      .post("/api/auth/login")
      .set("x-forwarded-for", `10.9.${(address >> 8) & 255}.${address & 255}`)
      .send({ phone, password })
  }

  async function failTimes(instance: ReturnType<typeof app>, phone: string, times: number) {
    const statuses: number[] = []
    for (let i = 0; i < times; i++) {
      statuses.push((await attempt(instance, phone, "definitely-not-the-password")).status)
    }
    return statuses
  }

  /** Moves the recorded failures into the past, which is what waiting does. */
  async function ageAttempts(phone: string, seconds: number) {
    await prisma.$executeRaw`
      UPDATE "auth_attempts"
         SET "createdAt" = "createdAt" - make_interval(secs => ${seconds}::double precision)
       WHERE "subject" = ${attemptSubject(phone, PEPPER())}
    `
  }

  it("lets three failures through and refuses the fourth", async () => {
    const instance = app()
    const phone = uniquePhone()

    const first = await failTimes(instance, phone, 3)
    expect(first, "three failures are free (FR-2.3)").toEqual([401, 401, 401])

    const fourth = await attempt(instance, phone, "definitely-not-the-password")
    expect(fourth.status).toBe(429)
    expect(fourth.body.error.code).toBe("AUTH_LOCKED")
  })

  it("names the wait in a header the client can read", async () => {
    const instance = app()
    const phone = uniquePhone()
    await failTimes(instance, phone, 3)

    const locked = await attempt(instance, phone, "definitely-not-the-password")

    // §12.3 renders "try again in X minutes" from this. Without it the client
    // has to guess, and guessing means either hammering or over-waiting.
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0)
    expect(Number(locked.headers["retry-after"])).toBeLessThanOrEqual(1)
  })

  it("doubles the wait with each further failure", async () => {
    const instance = app()
    const phone = uniquePhone()
    await failTimes(instance, phone, 3)

    // Wait out the first second, fail again, and the next wait is two.
    await ageAttempts(phone, 2)
    const fourth = await attempt(instance, phone, "definitely-not-the-password")
    expect(fourth.status, "the delay had elapsed").toBe(401)

    const fifth = await attempt(instance, phone, "definitely-not-the-password")
    expect(fifth.status).toBe(429)
    expect(Number(fifth.headers["retry-after"])).toBe(2)
  })

  it("stops growing at fifteen minutes", async () => {
    const instance = app()
    const phone = uniquePhone()

    // Twenty failures would ask for 2^17 seconds — a day and a half — if the
    // cap were missing, which locks the real owner out far longer than it
    // inconveniences anyone.
    for (let i = 0; i < 20; i++) {
      await ageAttempts(phone, 3600)
      await attempt(instance, phone, "definitely-not-the-password")
    }

    const locked = await attempt(instance, phone, "definitely-not-the-password")
    expect(locked.status).toBe(429)
    expect(Number(locked.headers["retry-after"])).toBeLessThanOrEqual(15 * 60)
  })

  it("forgets the failures once someone signs in", async () => {
    const instance = app()
    const phone = uniquePhone()
    const password = PASSWORD

    const registered = await request(instance)
      .post("/api/auth/register")
      .set("x-forwarded-for", "10.9.200.1")
      .send({ phone, firstName: "Back", lastName: "Off", password })
    expect(registered.status).toBe(201)

    await failTimes(instance, phone, 3)
    await ageAttempts(phone, 2)

    const good = await attempt(instance, phone, password)
    expect(good.status).toBe(200)

    // Counted as consecutive failures since the last success, so proving who
    // you are clears the penalty rather than leaving it to expire.
    const after = await failTimes(instance, phone, 3)
    expect(after).toEqual([401, 401, 401])
  })

  it("backs off an unregistered number on the same schedule", async () => {
    /*
     * The property this whole design exists for.
     *
     * A backoff that only applies to real accounts answers the fourth attempt
     * with 429 for a customer and 401 for a stranger — a membership oracle,
     * and a cheaper one than the ~6ms timing difference and the extra INSERT
     * that FR-2.2 and S-5 were written to close.
     */
    const instance = app()
    const stranger = uniquePhone()

    const known = uniquePhone()
    await request(instance)
      .post("/api/auth/register")
      .set("x-forwarded-for", "10.9.201.1")
      .send({ phone: known, firstName: "Known", lastName: "User", password: PASSWORD })

    await failTimes(instance, stranger, 3)
    await failTimes(instance, known, 3)

    const strangerLocked = await attempt(instance, stranger, "nope")
    const knownLocked = await attempt(instance, known, "nope")

    expect(strangerLocked.status).toBe(knownLocked.status)
    expect(strangerLocked.status).toBe(429)
    expect(strangerLocked.body.error.code).toBe(knownLocked.body.error.code)
  })
})

describe.skipIf(!hasDatabase)("P-16 — revocation reaches the money routes", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  /** Registers, then triggers reuse detection, returning the pre-theft token. */
  async function stolenSession() {
    const { app } = buildApp(prisma, { ...process.env })

    const registered = await request(app).post("/api/auth/register").send(registration())
    expect(registered.status).toBe(201)
    const accessToken = registered.body.accessToken as string
    const cookie = registered.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""

    // Spend the refresh token, then replay it: §11.3's reuse detection.
    const rotated = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(rotated.status).toBe(200)

    const replay = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe("AUTH_REFRESH_REUSED")

    return { app, accessToken }
  }

  it("refuses a transfer made with a token minted before the theft", async () => {
    const { app, accessToken } = await stolenSession()

    const res = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${accessToken}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: uniquePhone(), amount: "300000" })

    // Without this the thief keeps spending for up to fifteen minutes after
    // the theft is detected, which is most of the way to not detecting it.
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("AUTH_TOKEN_EXPIRED")
  })

  it("refuses a top-up with the same token", async () => {
    const { app, accessToken } = await stolenSession()

    const res = await request(app)
      .post("/api/accounts/topup")
      .set("authorization", `Bearer ${accessToken}`)
      .set("idempotency-key", randomUUID())
      .send()

    expect(res.status).toBe(401)
  })

  it("still serves the reads, which is the point of scoping it", async () => {
    const { app, accessToken } = await stolenSession()

    /*
     * Deliberate, not an oversight. Putting the check on every route adds a
     * database read to /me, to the balance and to history — the calls a client
     * makes constantly — to shorten a window that only matters where something
     * irreversible happens. FR-2.6 states the fifteen-minute bound; P-16
     * closes it where the cost of the bound is money.
     */
    const me = await request(app).get("/api/me").set("authorization", `Bearer ${accessToken}`)
    expect(me.status).toBe(200)
  })

  it("lets the freshly issued token through", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const registered = await request(app).post("/api/auth/register").send(registration())
    const cookie = registered.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""

    const rotated = await request(app).post("/api/auth/refresh").set("cookie", cookie)
    await request(app).post("/api/auth/refresh").set("cookie", cookie)

    // Issued before the revocation instant by a second or so, but the check
    // has to admit the token the *legitimate* rotation produced or a user who
    // was never robbed cannot transact.
    const fresh = rotated.body.accessToken as string
    const res = await request(app)
      .post("/api/accounts/topup")
      .set("authorization", `Bearer ${fresh}`)
      .set("idempotency-key", randomUUID())
      .send()

    expect([201, 401]).toContain(res.status)
  })

  it("an ordinary logout does not sign the other devices out", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const registered = await request(app).post("/api/auth/register").send(registration())
    const phone = registered.body.user.phone as string
    const accessToken = registered.body.accessToken as string
    const cookie = registered.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""

    await request(app).post("/api/auth/logout").set("cookie", cookie)

    // Logging out ends one session. `tokensValidAfter` ends every session on
    // every device, so only theft sets it — otherwise signing out of a laptop
    // would sign the phone out too.
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { tokensValidAfter: true },
    })
    expect(user?.tokensValidAfter).toBeNull()

    const stillWorks = await request(app)
      .get("/api/me")
      .set("authorization", `Bearer ${accessToken}`)
    expect(stillWorks.status).toBe(200)
  })
})
