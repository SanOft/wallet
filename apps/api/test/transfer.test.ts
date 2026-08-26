import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { TransferService } from "../src/domain/TransferService.js"
import { LedgerRepository } from "../src/infra/LedgerRepository.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv } from "./helpers.js"

const hasDatabase = Boolean(process.env.DATABASE_URL)

const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

/** 1 000 UZS in tiyin — the FR-4.7 minimum. */
const MIN_TRANSFER = 100_000n

function uniquePhone(): string {
  return `+99891${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
}

describe.skipIf(!hasDatabase)("money transfer (FR-4)", () => {
  let prisma: PrismaClient
  let treasuryAccountId: string

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    const seeded = await seed(prisma)
    treasuryAccountId = seeded.accountId
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  /**
   * Registers a user and returns their token and account.
   */
  async function newUser() {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Test", lastName: "Holder", password: PASSWORD })

    const account = await prisma.account.findFirstOrThrow({ where: { user: { phone } } })
    return { app, phone, token: res.body.accessToken as string, accountId: account.id }
  }

  /**
   * Funds an account from the treasury the way day 5's TOPUP will: one
   * transaction, a COMPLETED transfer, exactly two entries summing to zero, and
   * both snapshots updated.
   *
   * Written by hand rather than through `TransferService` because the service
   * applies FR-6 limits, and the treasury funding several test users in one run
   * would trip the velocity rule — a control that is correct for a user and
   * meaningless for a fixture.
   */
  async function fund(accountId: string, amount: bigint): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const treasury = await tx.account.findUniqueOrThrow({ where: { id: treasuryAccountId } })
      const target = await tx.account.findUniqueOrThrow({ where: { id: accountId } })

      const transfer = await tx.transfer.create({
        data: {
          fromAccountId: treasuryAccountId,
          toAccountId: accountId,
          amount,
          type: "TOPUP",
          channel: "WEB",
          idempotencyKey: randomUUID(),
          status: "PENDING",
        },
      })

      await new LedgerRepository(tx).append([
        {
          accountId: treasuryAccountId,
          transferId: transfer.id,
          amount: -amount,
          balanceAfter: treasury.balance - amount,
        },
        {
          accountId,
          transferId: transfer.id,
          amount,
          balanceAfter: target.balance + amount,
        },
      ])

      await tx.account.update({
        where: { id: treasuryAccountId },
        data: { balance: treasury.balance - amount },
      })
      await tx.account.update({
        where: { id: accountId },
        data: { balance: target.balance + amount },
      })
      await tx.transfer.update({
        where: { id: transfer.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      })
    })
  }

  function send(
    app: ReturnType<typeof buildApp>["app"],
    token: string,
    body: { phone: string; amount: string },
    key = randomUUID(),
  ) {
    return request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send(body)
  }

  it("moves money and writes exactly two entries that cancel (FR-4.2, I-2)", async () => {
    const sender = await newUser()
    const recipient = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const res = await send(sender.app, sender.token, {
      phone: recipient.phone,
      amount: "500000",
    })

    expect(res.status).toBe(201)
    expect(res.body.status).toBe("COMPLETED")
    // §12.2: amounts are strings on the wire, never numbers.
    expect(res.body.amount).toBe("500000")
    expect(typeof res.body.amount).toBe("string")

    const entries = await prisma.ledgerEntry.findMany({ where: { transferId: res.body.id } })
    expect(entries).toHaveLength(2)
    expect(entries.reduce((sum, e) => sum + e.amount, 0n)).toBe(0n)

    // `balanceAfter` must agree with the journal, not merely cancel (§9.2).
    const ledger = new LedgerRepository(prisma)
    for (const entry of entries) {
      expect(entry.balanceAfter).toBe(await ledger.balanceOf(entry.accountId))
    }

    const senderAccount = await prisma.account.findUniqueOrThrow({
      where: { id: sender.accountId },
    })
    expect(senderAccount.balance).toBe(500_000n)
    expect(senderAccount.balance).toBe(await ledger.balanceOf(sender.accountId))
  })

  it("S-1: the same Idempotency-Key twice produces two ledger rows, not four", async () => {
    const sender = await newUser()
    const recipient = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const key = randomUUID()
    const body = { phone: recipient.phone, amount: "300000" }

    const first = await send(sender.app, sender.token, body, key)
    const second = await send(sender.app, sender.token, body, key)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const entries = await prisma.ledgerEntry.findMany({ where: { transferId: first.body.id } })
    expect(entries).toHaveLength(2)

    // The funding TOPUP is sent *from* the treasury, so only the P2P counts here.
    const transfers = await prisma.transfer.count({ where: { fromAccountId: sender.accountId } })
    expect(transfers).toBe(1)

    const account = await prisma.account.findUniqueOrThrow({ where: { id: sender.accountId } })
    expect(account.balance).toBe(700_000n)
  })

  it("S-1 concurrent: one key sent twice at once still moves money once", async () => {
    const sender = await newUser()
    const recipient = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const key = randomUUID()
    const body = { phone: recipient.phone, amount: "300000" }

    // The interleaving a retrying client actually produces.
    const [a, b] = await Promise.all([
      send(sender.app, sender.token, body, key),
      send(sender.app, sender.token, body, key),
    ])

    const accepted = [a, b].filter((res) => res.status === 201)
    expect(accepted.length).toBeGreaterThanOrEqual(1)

    const p2p = await prisma.transfer.count({
      where: { fromAccountId: sender.accountId, type: "P2P" },
    })
    expect(p2p).toBe(1)

    const account = await prisma.account.findUniqueOrThrow({ where: { id: sender.accountId } })
    expect(account.balance).toBe(700_000n)
  })

  it("rejects the same key with a different payload (FR-4.4)", async () => {
    const sender = await newUser()
    const recipient = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const key = randomUUID()
    await send(sender.app, sender.token, { phone: recipient.phone, amount: "300000" }, key)
    const conflict = await send(
      sender.app,
      sender.token,
      { phone: recipient.phone, amount: "400000" },
      key,
    )

    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("S-2: two concurrent transfers when only one is funded", async () => {
    const sender = await newUser()
    const first = await newUser()
    const second = await newUser()
    // Enough for exactly one of the two transfers below.
    await fund(sender.accountId, 300_000n)

    const [a, b] = await Promise.all([
      send(sender.app, sender.token, { phone: first.phone, amount: "300000" }),
      send(sender.app, sender.token, { phone: second.phone, amount: "300000" }),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(201)
    expect(statuses[1]).not.toBe(201)

    const account = await prisma.account.findUniqueOrThrow({ where: { id: sender.accountId } })
    // I-5: the balance never goes negative, whichever way the race resolved.
    expect(account.balance).toBe(0n)
    expect(account.balance).toBeGreaterThanOrEqual(0n)

    const completed = await prisma.transfer.count({
      where: { fromAccountId: sender.accountId, type: "P2P", status: "COMPLETED" },
    })
    expect(completed).toBe(1)
  })

  it("S-3: a caller cannot spend an account they do not own", async () => {
    const victim = await newUser()
    const attacker = await newUser()
    const recipient = await newUser()
    await fund(victim.accountId, 1_000_000n)

    // The attacker holds their own token; the sender account is resolved from
    // it, so there is no id they could substitute. The transfer must fail on
    // their own empty balance, never touch the victim's.
    const res = await send(attacker.app, attacker.token, {
      phone: recipient.phone,
      amount: "300000",
    })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("INSUFFICIENT_FUNDS")

    const victimAccount = await prisma.account.findUniqueOrThrow({
      where: { id: victim.accountId },
    })
    expect(victimAccount.balance).toBe(1_000_000n)
  })

  it("refuses a transfer to yourself (FR-4.7)", async () => {
    const sender = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const res = await send(sender.app, sender.token, { phone: sender.phone, amount: "300000" })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe("SELF_TRANSFER_FORBIDDEN")
  })

  it("answers an unregistered recipient the same way as an unfunded sender", async () => {
    const sender = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const res = await send(sender.app, sender.token, { phone: uniquePhone(), amount: "300000" })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("RECIPIENT_NOT_FOUND")
  })

  it("requires an Idempotency-Key (§12.2)", async () => {
    const sender = await newUser()
    const recipient = await newUser()

    const res = await request(sender.app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${sender.token}`)
      .send({ phone: recipient.phone, amount: "300000" })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(res.body.error.details).toContainEqual({
      path: ["Idempotency-Key"],
      code: "field.required",
    })
  })

  it("requires authentication", async () => {
    const recipient = await newUser()
    const { app } = buildApp(prisma, { ...process.env })

    const res = await request(app)
      .post("/api/transfers")
      .set("idempotency-key", randomUUID())
      .send({ phone: recipient.phone, amount: "300000" })

    expect(res.status).toBe(401)
  })
})

describe.skipIf(!hasDatabase)("anti-fraud limits (FR-6)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("refuses an amount below the minimum (FR-4.7)", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const created = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "A", lastName: "B", password: PASSWORD })
    const recipientPhone = uniquePhone()
    await request(app)
      .post("/api/auth/register")
      .send({ phone: recipientPhone, firstName: "C", lastName: "D", password: PASSWORD })

    const res = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${created.body.accessToken}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: recipientPhone, amount: (MIN_TRANSFER - 100n).toString() })

    expect(res.status).toBe(400)
    expect(res.body.error.details).toContainEqual({
      path: ["amount"],
      code: "money.below_minimum",
    })
  })

  it("names which limit was hit (FR-6.1, §12.3)", async () => {
    // Exercised through the service with `channel: "USSD"` rather than over
    // HTTP, because the WEB per-operation limit (10 000 000 UZS, FR-6.1) is
    // the *same number* as FR-4.7's absolute maximum — so on the web channel
    // `money.above_maximum` always fires first and `limit.per_operation` is
    // unreachable. It is a real rule only for USSD, whose limit is twenty
    // times lower. Recorded as P-18.
    const { app } = buildApp(prisma, { ...process.env })
    const senderPhone = uniquePhone()
    await request(app)
      .post("/api/auth/register")
      .send({ phone: senderPhone, firstName: "A", lastName: "B", password: PASSWORD })
    const recipientPhone = uniquePhone()
    await request(app)
      .post("/api/auth/register")
      .send({ phone: recipientPhone, firstName: "C", lastName: "D", password: PASSWORD })

    const sender = await prisma.user.findUniqueOrThrow({ where: { phone: senderPhone } })
    const transfers = new TransferService({ prisma })

    // 600 000 UZS: fine on the web, above the USSD per-operation cap.
    await expect(
      transfers.execute({
        senderUserId: sender.id,
        recipientPhone,
        amount: 60_000_000n,
        idempotencyKey: randomUUID(),
        channel: "USSD",
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      details: [{ path: ["amount"], code: "limit.per_operation" }],
    })
  })

  it("refuses an amount that is not a whole so'm (FR-4.7)", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const senderPhone = uniquePhone()
    const created = await request(app)
      .post("/api/auth/register")
      .send({ phone: senderPhone, firstName: "A", lastName: "B", password: PASSWORD })
    const recipientPhone = uniquePhone()
    await request(app)
      .post("/api/auth/register")
      .send({ phone: recipientPhone, firstName: "C", lastName: "D", password: PASSWORD })

    const res = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${created.body.accessToken}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: recipientPhone, amount: "100050" })

    expect(res.status).toBe(400)
    expect(res.body.error.details).toContainEqual({
      path: ["amount"],
      code: "money.invalid_step",
    })
  })
})

describe.skipIf(!hasDatabase)("S-7: the global invariant", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("sum(ledger) = 0 across the whole system (I-1)", async () => {
    // §9.4: every credit came from somewhere, including demo money, which comes
    // from the treasury. If this is ever non-zero, value was created.
    expect(await new LedgerRepository(prisma).sumOfAllEntries()).toBe(0n)
  })

  it("every account's snapshot agrees with its journal (I-4)", async () => {
    const ledger = new LedgerRepository(prisma)
    const accounts = await prisma.account.findMany({ select: { id: true, balance: true } })

    for (const account of accounts) {
      const derived = await ledger.balanceOf(account.id)
      expect(account.balance, `account ${account.id} drifted`).toBe(derived)
    }
  })
})
