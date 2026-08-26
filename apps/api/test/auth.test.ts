import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { publicUserSchema } from "@wallet/shared"
import { SignJWT } from "jose"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { REFRESH_COOKIE } from "../src/adapters/http/cookies.js"
import { hashRefreshToken, hashSecret, verifySecret } from "../src/infra/crypto.js"
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

  it("round-trips a subject", async () => {
    const userId = randomUUID()
    const claims = await tokens.verify(await tokens.sign({ userId }))
    expect(claims).toEqual({ userId })
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
   * The minimum approximates the work with the scheduler noise removed, so it
   * is stable on a loaded CI runner where a median wanders. The bound is a
   * ratio, not a millisecond figure: an absolute bound has to be chosen
   * relative to one argon2 verify (~40ms here), and a 50ms budget therefore
   * fails to reject an 8x separation — which is how the original version of
   * this test passed with the leak it names still present.
   */
  async function timingRatio(
    app: Parameters<typeof request>[0],
    a: { phone: string; password: string },
    b: { phone: string; password: string },
    samples = 12,
  ) {
    const timesA: number[] = []
    const timesB: number[] = []

    for (let i = 0; i < samples; i++) {
      // Interleaved, so a drift in machine load hits both arms equally.
      const startedA = performance.now()
      await request(app).post("/api/auth/login").send(a)
      timesA.push(performance.now() - startedA)

      const startedB = performance.now()
      await request(app).post("/api/auth/login").send(b)
      timesB.push(performance.now() - startedB)
    }

    const lo = Math.min(...timesA)
    const hi = Math.min(...timesB)
    return { a: lo, b: hi, ratio: Math.max(lo, hi) / Math.max(Math.min(lo, hi), 0.001) }
  }

  it("S-5: an unknown number is indistinguishable from a wrong password", async () => {
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
    expect(ratio, `unknown ${a.toFixed(1)}ms vs wrong-password ${b.toFixed(1)}ms`).toBeLessThan(1.5)
  })

  it("the SYSTEM account is not identifiable by how fast it fails", async () => {
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

    expect(ratio, `system ${a.toFixed(1)}ms vs unknown ${b.toFixed(1)}ms`).toBeLessThan(1.5)
  })

  it("records an attempt whether or not the number is registered", async () => {
    // Writing the row only for known numbers cost one extra INSERT and made
    // registered numbers measurably slower — an enumeration oracle (§11.2).
    const { app } = buildApp(prisma, { ...process.env })
    const stranger = uniquePhone()

    const before = await prisma.authAttempt.count()
    await request(app).post("/api/auth/login").send({ phone: stranger, password: PASSWORD })
    const after = await prisma.authAttempt.count()

    expect(after).toBe(before + 1)
    const latest = await prisma.authAttempt.findFirst({ orderBy: { createdAt: "desc" } })
    expect(latest?.userId).toBeNull()
    expect(latest?.succeeded).toBe(false)
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
