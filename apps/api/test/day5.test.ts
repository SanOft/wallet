import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { DEMO_TOPUP_AMOUNT, maskRecipientName } from "@wallet/shared"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { resetLookupWindows } from "../src/adapters/http/routes/recipients.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { isHealthy, reconcile } from "../src/infra/reconciliation.js"
import { buildApp, testEnv } from "./helpers.js"

const hasDatabase = Boolean(process.env.DATABASE_URL)
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

function uniquePhone(): string {
  return `+99894${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
}

describe.skipIf(!hasDatabase)("day 5 — top-up, accounts and lookup", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })
  beforeEach(() => {
    resetLookupWindows()
  })

  async function newUser(firstName = "Muhammadali", lastName = "Toshmatov") {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName, lastName, password: PASSWORD })
    return { app, phone, firstName, lastName, token: res.body.accessToken as string }
  }

  describe("demo top-up (FR-10)", () => {
    it("credits 1 000 000 UZS from the treasury, keeping sum(ledger) at zero", async () => {
      const user = await newUser()

      const before = await sumLedger(prisma)
      const res = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send()

      expect(res.status).toBe(201)
      expect(res.body.type).toBe("TOPUP")
      // FR-10.1, as a string in minor units (§12.2).
      expect(res.body.amount).toBe(DEMO_TOPUP_AMOUNT.toString())

      // FR-10.2: the money came from the mint, not from nowhere.
      expect(await sumLedger(prisma)).toBe(before)

      const entries = await prisma.ledgerEntry.findMany({ where: { transferId: res.body.id } })
      expect(entries).toHaveLength(2)
      expect(entries.reduce((sum, e) => sum + e.amount, 0n)).toBe(0n)

      const treasuryEntry = entries.find((e) => e.amount < 0n)
      const treasury = await prisma.account.findFirstOrThrow({ where: { type: "TREASURY" } })
      expect(treasuryEntry?.accountId).toBe(treasury.id)
    })

    it("FR-10.3: at most three in twenty-four hours", async () => {
      const user = await newUser()

      for (let i = 0; i < 3; i++) {
        const ok = await request(user.app)
          .post("/api/accounts/topup")
          .set("authorization", `Bearer ${user.token}`)
          .set("idempotency-key", randomUUID())
          .send()
        expect(ok.status, `top-up ${i + 1}`).toBe(201)
      }

      const fourth = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send()

      expect(fourth.status).toBe(422)
      expect(fourth.body.error.code).toBe("LIMIT_EXCEEDED")
    })

    it("a double-tapped button mints once (§12.2, S-6)", async () => {
      const user = await newUser()
      const key = randomUUID()

      const [a, b] = await Promise.all([
        request(user.app)
          .post("/api/accounts/topup")
          .set("authorization", `Bearer ${user.token}`)
          .set("idempotency-key", key)
          .send(),
        request(user.app)
          .post("/api/accounts/topup")
          .set("authorization", `Bearer ${user.token}`)
          .set("idempotency-key", key)
          .send(),
      ])

      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      expect(b.body.id).toBe(a.body.id)

      const topups = await prisma.transfer.count({
        where: { idempotencyKey: key, type: "TOPUP" },
      })
      expect(topups).toBe(1)
    })

    it("requires an Idempotency-Key, like every money-moving POST", async () => {
      const user = await newUser()
      const res = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .send()

      expect(res.status).toBe(400)
      expect(res.body.error.details).toContainEqual({
        path: ["Idempotency-Key"],
        code: "field.required",
      })
    })
  })

  describe("GET /api/accounts (FR-3)", () => {
    it("returns the balance as a string and the public user", async () => {
      const user = await newUser()
      await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send()

      const res = await request(user.app)
        .get("/api/accounts")
        .set("authorization", `Bearer ${user.token}`)

      expect(res.status).toBe(200)
      expect(res.body.accounts).toHaveLength(1)
      // §12.2: never a number. 90 billion so'm is where a JSON number starts
      // losing tiyin, and a balance is not a place to find that out.
      expect(typeof res.body.accounts[0].balance).toBe("string")
      expect(res.body.accounts[0].balance).toBe(DEMO_TOPUP_AMOUNT.toString())
      expect(res.body.accounts[0].currency).toBe("UZS")
      expect(res.body.user.phone).toBe(user.phone)
      expect(JSON.stringify(res.body)).not.toContain("$argon2")
    })

    it("shows only the caller's own accounts", async () => {
      const mine = await newUser()
      const theirs = await newUser()
      await request(theirs.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${theirs.token}`)
        .set("idempotency-key", randomUUID())
        .send()

      const res = await request(mine.app)
        .get("/api/accounts")
        .set("authorization", `Bearer ${mine.token}`)

      expect(res.body.accounts).toHaveLength(1)
      expect(res.body.accounts[0].balance).toBe("0")
      expect(res.body.user.phone).toBe(mine.phone)
    })

    it("refuses without a token", async () => {
      const { app } = buildApp(prisma, { ...process.env })
      expect((await request(app).get("/api/accounts")).status).toBe(401)
    })
  })

  describe("recipient lookup (FR-4.9)", () => {
    it("returns a masked name on an exact match", async () => {
      const caller = await newUser()
      const target = await newUser("Muhammadali", "Toshmatov")

      const res = await request(caller.app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${caller.token}`)

      expect(res.status).toBe(200)
      // §11.4 draws exactly this shape.
      expect(res.body.maskedName).toBe("MUHAMMADALI T.")
      // The family name never leaves the process in full.
      expect(res.body.maskedName).not.toContain("TOSHMATOV")
      expect(JSON.stringify(res.body)).not.toContain(target.lastName)
    })

    it("answers an unregistered number with RECIPIENT_NOT_FOUND", async () => {
      const caller = await newUser()

      const res = await request(caller.app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(uniquePhone())}`)
        .set("authorization", `Bearer ${caller.token}`)

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe("RECIPIENT_NOT_FOUND")
    })

    it("will not reveal the treasury", async () => {
      const caller = await newUser()

      const res = await request(caller.app)
        .get("/api/recipients/lookup?phone=%2B998000000000")
        .set("authorization", `Bearer ${caller.token}`)

      // The same answer as an unregistered number: the mint is not payable and
      // its existence is not confirmable through this endpoint.
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe("RECIPIENT_NOT_FOUND")
    })

    it("stops after twenty lookups in an hour", async () => {
      const caller = await newUser()
      const target = await newUser()

      for (let i = 0; i < 20; i++) {
        const ok = await request(caller.app)
          .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
          .set("authorization", `Bearer ${caller.token}`)
        expect(ok.status, `lookup ${i + 1}`).toBe(200)
      }

      const blocked = await request(caller.app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${caller.token}`)

      expect(blocked.status).toBe(429)
      expect(blocked.body.error.code).toBe("RATE_LIMITED")
    })

    it("counts the limit per user, not globally", async () => {
      const heavy = await newUser()
      const light = await newUser()
      const target = await newUser()

      for (let i = 0; i < 20; i++) {
        await request(heavy.app)
          .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
          .set("authorization", `Bearer ${heavy.token}`)
      }

      // One user exhausting their allowance must not lock everybody out.
      const other = await request(light.app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${light.token}`)

      expect(other.status).toBe(200)
    })

    it("refuses a malformed number before spending an allowance", async () => {
      const caller = await newUser()

      const res = await request(caller.app)
        .get("/api/recipients/lookup?phone=998901234567")
        .set("authorization", `Bearer ${caller.token}`)

      expect(res.status).toBe(400)
      expect(res.body.error.details).toContainEqual({
        path: ["phone"],
        code: "phone.invalid_format",
      })
    })
  })

  describe("name masking is one implementation (FR-4.6)", () => {
    it("keeps the given name and one initial", () => {
      expect(maskRecipientName("Muhammadali", "Toshmatov")).toBe("MUHAMMADALI T.")
      expect(maskRecipientName("Alisher", "Navoiy")).toBe("ALISHER N.")
    })

    it("survives a single-word name", () => {
      expect(maskRecipientName("Alisher", "")).toBe("ALISHER")
    })
  })
})

async function sumLedger(prisma: PrismaClient): Promise<bigint> {
  const result = await prisma.ledgerEntry.aggregate({ _sum: { amount: true } })
  return result._sum.amount ?? 0n
}

describe.skipIf(!hasDatabase)("reconciliation (I-4, §20.4)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("reports a healthy system after the whole suite", async () => {
    const report = await reconcile(prisma)

    expect(report.globalSum).toBe(0n)
    expect(report.drifts).toEqual([])
    expect(isHealthy(report)).toBe(true)
  })

  it("finds a drift the moment one exists, and names the account", async () => {
    // The detector has to be shown detecting. A reconciliation that has only
    // ever been run against a healthy database is an untested alarm.
    const account = await prisma.account.findFirstOrThrow({ where: { type: "USER" } })
    const original = account.balance

    await prisma.account.update({
      where: { id: account.id },
      data: { balance: original + 12345n },
    })

    const report = await reconcile(prisma)
    expect(isHealthy(report)).toBe(false)
    expect(report.drifts).toHaveLength(1)
    expect(report.drifts[0]?.accountId).toBe(account.id)
    expect(report.drifts[0]?.drift).toBe(12345n)
    // The ledger itself is untouched — only the cached snapshot lied.
    expect(report.globalSum).toBe(0n)

    await prisma.account.update({ where: { id: account.id }, data: { balance: original } })
    expect(isHealthy(await reconcile(prisma))).toBe(true)
  })
})
