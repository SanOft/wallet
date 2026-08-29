import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { DEMO_TOPUP_AMOUNT, maskRecipientName, TRANSFER_LIMITS } from "@wallet/shared"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { isHealthy, reconcile } from "../src/infra/reconciliation.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

const hasDatabase = Boolean(process.env.DATABASE_URL)
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

describe.skipIf(!hasDatabase)("day 5 — top-up, accounts and lookup", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
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

    it("refuses a body, rather than ignoring one", async () => {
      // The amount is fixed by FR-10.1 and the account comes from the token, so
      // a client sending either believes something untrue. It used to get a 201.
      const user = await newUser()
      const res = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send({ amount: "999999999", accountId: "somebody-else" })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })

    it("a refused top-up is recorded, and its key is spent", async () => {
      // FR-4.8: a refusal is a FAILED transfer, not the absence of one. The
      // top-up path skipped this, so the key stayed live and minted again a
      // day later — §12.2 says that is a 409.
      const user = await newUser()
      for (let i = 0; i < 3; i++) {
        await request(user.app)
          .post("/api/accounts/topup")
          .set("authorization", `Bearer ${user.token}`)
          .set("idempotency-key", randomUUID())
          .send()
      }

      const key = randomUUID()
      const refused = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", key)
        .send()
      expect(refused.status).toBe(422)

      const failed = await prisma.transfer.findFirst({ where: { idempotencyKey: key } })
      expect(failed?.status).toBe("FAILED")
      expect(failed?.failReason).toBe("LIMIT_EXCEEDED")

      const stored = await prisma.idempotencyRecord.findFirst({ where: { key } })
      expect(stored).not.toBeNull()

      // Replaying the key returns the stored refusal rather than executing.
      const replay = await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", key)
        .send()
      expect(replay.status).toBe(422)
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

  describe("which refusal a web caller can reach (P-18)", () => {
    it("answers an over-large transfer as a bad amount, not as a breached limit", async () => {
      /*
       * FR-4.7's maximum and FR-6.1's web cap are the same number, and
       * `#assertAmountIsSane` runs on the line before `#assertWithinLimits`. So
       * nothing can be at once within the maximum and above the cap, and
       * `limit.per_operation` is unreachable on this channel.
       *
       * `reachable-limits.test.ts` pins the two constants. This pins the
       * consequence, which is the half that would change if somebody swapped
       * the order of those two checks: the constants would be untouched and the
       * error a user sees would flip from 400 to 422.
       */
      const sender = await newUser()
      const target = await newUser("Amina", "Jurayeva")

      const res = await request(sender.app)
        .post("/api/transfers")
        .set("authorization", `Bearer ${sender.token}`)
        .set("idempotency-key", randomUUID())
        // With the step-up password, deliberately. `#assertStepUp` runs before
        // the transaction, so without it the answer is `STEP_UP_REQUIRED` and
        // the amount is never examined at all — which is a third refusal this
        // channel reaches first, and was not obvious until it was measured.
        .send({
          phone: target.phone,
          amount: String(TRANSFER_LIMITS.UZS.max + 100n),
          password: PASSWORD,
        })

      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
      expect(res.body.error.details?.[0]?.code).toBe("money.above_maximum")
    })
  })

  describe("the daily allowance (FR-6.1, P-32)", () => {
    it("reports what is left, from the same rule that would refuse the transfer", async () => {
      /*
       * 13.5 asks the amount step to show this and F4 shipped without it,
       * because the only client-side route to a figure was summing a paged
       * history — right until somebody exceeds one page in a day, and silently
       * wrong after that.
       */
      const user = await newUser()

      const before = await request(user.app)
        .get("/api/accounts")
        .set("authorization", `Bearer ${user.token}`)

      expect(before.status).toBe(200)
      expect(before.body.limits.daily.spent).toBe("0")
      expect(before.body.limits.daily.remaining).toBe(before.body.limits.daily.limit)

      const target = await newUser()
      await request(user.app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send()
      await request(user.app)
        .post("/api/transfers")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", randomUUID())
        .send({ phone: target.phone, amount: "300000" })

      const after = await request(user.app)
        .get("/api/accounts")
        .set("authorization", `Bearer ${user.token}`)

      // The transfer counted; the top-up did not, because a top-up is not an
      // outgoing transfer from this account.
      expect(after.body.limits.daily.spent).toBe("300000")
      expect(BigInt(after.body.limits.daily.remaining)).toBe(
        BigInt(after.body.limits.daily.limit) - 300_000n,
      )
    })

    it("never reports a negative allowance", async () => {
      // A lowered limit can leave somebody already over it, and
      // "-2 000 000 so'm remaining" is not a sentence a screen should render.
      const user = await newUser()

      const res = await request(user.app)
        .get("/api/accounts")
        .set("authorization", `Bearer ${user.token}`)

      expect(BigInt(res.body.limits.daily.remaining)).toBeGreaterThanOrEqual(0n)
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
      const target = await newUser()

      const bad = await request(caller.app)
        .get("/api/recipients/lookup?phone=998901234567")
        .set("authorization", `Bearer ${caller.token}`)

      expect(bad.status).toBe(400)
      expect(bad.body.error.details).toContainEqual({
        path: ["phone"],
        code: "phone.invalid_format",
      })

      // The point of the test's name, which the earlier version never checked:
      // twenty malformed requests must leave the allowance untouched.
      for (let i = 0; i < 19; i++) {
        await request(caller.app)
          .get("/api/recipients/lookup?phone=not-a-number")
          .set("authorization", `Bearer ${caller.token}`)
      }

      const ok = await request(caller.app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${caller.token}`)
      expect(ok.status).toBe(200)
    })

    it("the window slides: an hour later the allowance is back", async () => {
      // Pins FR-4.9's *window*, not just its count. Mutations that shrank the
      // window sixtyfold, or removed the sliding filter so twenty was a
      // per-process lifetime cap, both passed the earlier suite.
      let clock = Date.now()
      const { app } = buildApp(prisma, { ...process.env }, () => clock)

      const phone = uniquePhone()
      const created = await request(app)
        .post("/api/auth/register")
        .send({ phone, firstName: "Win", lastName: "Dow", password: PASSWORD })
      const token = created.body.accessToken as string
      const target = await newUser()

      for (let i = 0; i < 20; i++) {
        const ok = await request(app)
          .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
          .set("authorization", `Bearer ${token}`)
        expect(ok.status, `lookup ${i + 1}`).toBe(200)
      }

      const blocked = await request(app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${token}`)
      expect(blocked.status).toBe(429)

      // Fifty-nine minutes is still inside the window.
      clock += 59 * 60 * 1000
      const stillBlocked = await request(app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${token}`)
      expect(stillBlocked.status).toBe(429)

      // Just past the hour, it is not.
      clock += 2 * 60 * 1000
      const allowed = await request(app)
        .get(`/api/recipients/lookup?phone=${encodeURIComponent(target.phone)}`)
        .set("authorization", `Bearer ${token}`)
      expect(allowed.status).toBe(200)
    })
  })

  describe("name masking is one implementation (FR-4.6)", () => {
    it("keeps the given name and one initial", () => {
      expect(maskRecipientName("Muhammadali", "Toshmatov")).toBe("MUHAMMADALI T.")
      expect(maskRecipientName("Alisher", "Navoiy")).toBe("ALISHER N.")
    })

    it("survives a single-word name", () => {
      expect(maskRecipientName("Alisher", "")).toBe("ALISHER")
      expect(maskRecipientName("", "Toshmatov")).toBe("T.")
    })

    /**
     * The earlier tests used two short ASCII surnames, and three mutations that
     * published the full surname — for long names, for non-Latin names, and
     * for an empty given name — all passed. `nameSchema` is deliberately
     * Unicode-aware, so these are the inputs the rule actually governs.
     */
    const SURNAMES = [
      "Toshmatov",
      "Rahmonberdiyev",
      "Abdurahmonov",
      "Петров",
      "Иванова",
      "Gʻulomov",
      "Müller",
      "ß",
      "Ölmez",
      String.fromCodePoint(0x1d4b2) + "illiams",
      "李",
      "O'Brien",
    ]

    it.each(SURNAMES)("never publishes more than one letter of %s", (surname) => {
      const masked = maskRecipientName("Ali", surname)

      // The rest of the surname is gone.
      const rest = [...surname].slice(1).join("")
      if (rest.length > 0) expect(masked).not.toContain(rest)

      // Exactly one code point, then a full stop.
      const initials = masked.slice("ALI ".length)
      expect([...initials]).toHaveLength(2)
      expect(initials.endsWith(".")).toBe(true)
    })

    it.each(SURNAMES)("emits well-formed Unicode for %s", (surname) => {
      const masked = maskRecipientName("Ali", surname)
      // An unpaired surrogate is an ill-formed string in a JSON body, and
      // `charAt(0)` produced one for any surname above the BMP.
      expect(masked).toBe(masked.toWellFormed())
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

    try {
      const report = await reconcile(prisma)
      expect(isHealthy(report)).toBe(false)
      expect(report.drifts.map((d) => d.accountId)).toContain(account.id)
      expect(report.drifts.find((d) => d.accountId === account.id)?.drift).toBe(12345n)
      // The ledger itself is untouched — only the cached snapshot lied.
      expect(report.globalSum).toBe(0n)
    } finally {
      // Without the `finally`, one failing assertion left the drift in place —
      // and ledger rows cannot be deleted, so the only repair was a hand-written
      // UPDATE. Four red runs during a review poisoned the shared database and
      // made a sibling test fail forever on unmutated code.
      await prisma.account.update({ where: { id: account.id }, data: { balance: original } })
    }

    expect(isHealthy(await reconcile(prisma))).toBe(true)
  })

  it("sees an account that has no ledger entries at all", async () => {
    // The LEFT JOIN and the COALESCE exist for this case, and the file's own
    // comment names it as the one that matters most. Two one-word mutations —
    // LEFT JOIN to JOIN, and dropping COALESCE — each blinded the query to 65%
    // of accounts while every test stayed green, because the drift test picked
    // an unordered "first row" that happened to have entries.
    const fresh = await prisma.user.create({
      data: {
        phone: uniquePhone(),
        firstName: "Zero",
        lastName: "Entries",
        passwordHash: "not-a-credential",
        accounts: { create: { currency: "UZS", type: "USER", balance: 0n } },
      },
      select: { accounts: { select: { id: true } } },
    })
    const accountId = fresh.accounts[0]?.id ?? ""

    const entries = await prisma.ledgerEntry.count({ where: { accountId } })
    expect(entries, "the fixture must genuinely have no entries").toBe(0)

    try {
      await prisma.account.update({ where: { id: accountId }, data: { balance: 777n } })

      const report = await reconcile(prisma)
      expect(report.drifts.map((d) => d.accountId)).toContain(accountId)
      expect(report.drifts.find((d) => d.accountId === accountId)?.drift).toBe(777n)
    } finally {
      await prisma.account.update({ where: { id: accountId }, data: { balance: 0n } })
    }

    expect(isHealthy(await reconcile(prisma))).toBe(true)
  })
})

describe.skipIf(!hasDatabase)("top-up under load (FR-10, NFR-2)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("twelve different users can each take their first top-up at once", async () => {
    // §13.4 makes "Demo top-up" the action on an empty Home screen, so this is
    // the onboarding path, not an edge case. Every top-up debits the same
    // treasury row, which under Serializable made it a global conflict point:
    // eight of twelve aborted and surfaced as INTERNAL. An advisory lock turns
    // the contention into a queue.
    const { app } = buildApp(prisma, { ...process.env })

    const tokens = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const res = await request(app).post("/api/auth/register").send({
          phone: uniquePhone(),
          firstName: "Load",
          lastName: "Tester",
          password: PASSWORD,
        })
        return res.body.accessToken as string
      }),
    )

    const results = await Promise.all(
      tokens.map((token) =>
        request(app)
          .post("/api/accounts/topup")
          .set("authorization", `Bearer ${token}`)
          .set("idempotency-key", randomUUID())
          .send(),
      ),
    )

    const statuses = results.map((r) => r.status)
    const failures = statuses.filter((s) => s !== 201)

    expect(failures, `statuses: ${statuses.join(",")}`).toEqual([])
    // And nothing was created out of nothing while they queued.
    expect(await reconcile(prisma).then((r) => r.globalSum)).toBe(0n)
  })
})
