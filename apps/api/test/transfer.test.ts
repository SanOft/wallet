import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { TransferService } from "../src/domain/TransferService.js"
import { LedgerRepository } from "../src/infra/LedgerRepository.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

const hasDatabase = Boolean(process.env.DATABASE_URL)

const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

/** 1 000 UZS in tiyin — the FR-4.7 minimum. */
const MIN_TRANSFER = 100_000n

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
      // The same lock `TransferService.topUp` takes, in the same order: lock,
      // then read. A fixture that writes the treasury without it can interleave
      // with a real top-up under ReadCommitted and lose one of the two
      // decrements — the entries both persist, so the journal stays balanced
      // while the cached balance is short. That is exactly the I-4 drift found
      // in the shared development database (three breaks, 2 300 000 tiyin).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:treasury'))`

      const treasury = await tx.account.findUniqueOrThrow({ where: { id: treasuryAccountId } })
      const target = await tx.account.findUniqueOrThrow({ where: { id: accountId } })

      const transfer = await tx.transfer.create({
        data: {
          fromAccountId: treasuryAccountId,
          toAccountId: accountId,
          // A top-up is initiated by the recipient: the money leaves the
          // treasury, which belongs to nobody in particular (§9.4).
          initiatedBy: target.userId,
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

  it("lets two people hold the same key at the same time (P-8)", async () => {
    /*
     * The key namespace used to be global: `idempotency_records.key` was the
     * whole primary key, and `transfers.idempotencyKey` carried its own global
     * unique constraint. Nothing leaked — the service already refuses to replay
     * a record owned by somebody else — but a client that reuses a fixed value,
     * or picks one deliberately, could turn other people's transfers into 409s.
     * A payment somebody else can block is a payment that does not happen.
     */
    const alice = await newUser()
    const bob = await newUser()
    const recipient = await newUser()
    await fund(alice.accountId, 1_000_000n)
    await fund(bob.accountId, 1_000_000n)

    const shared = randomUUID()
    const first = await send(
      alice.app,
      alice.token,
      { phone: recipient.phone, amount: "300000" },
      shared,
    )
    const second = await send(
      bob.app,
      bob.token,
      { phone: recipient.phone, amount: "300000" },
      shared,
    )

    expect(first.status).toBe(201)
    expect(second.status, "the second user was blocked by the first").toBe(201)
    expect(second.body.id).not.toBe(first.body.id)
  })

  it("still refuses the same key twice from one person", async () => {
    // The scoping must not weaken FR-4.4 for the case it exists for.
    const sender = await newUser()
    const recipient = await newUser()
    await fund(sender.accountId, 1_000_000n)

    const key = randomUUID()
    const body = { phone: recipient.phone, amount: "300000" }
    const first = await send(sender.app, sender.token, body, key)
    const replay = await send(sender.app, sender.token, body, key)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    // A replay, not a second transfer.
    expect(replay.body.id).toBe(first.body.id)

    const count = await prisma.transfer.count({
      where: { fromAccountId: sender.accountId, type: "P2P" },
    })
    expect(count).toBe(1)
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

    // 18.2 S-2 says "one COMPLETED, one FAILED". Counting only the completed
    // one passed for as long as FAILED was unreachable and failReason was a
    // dead column.
    const failed = await prisma.transfer.findMany({
      where: { fromAccountId: sender.accountId, status: "FAILED" },
    })
    expect(failed).toHaveLength(1)
    expect(failed[0]?.failReason).toBe("INSUFFICIENT_FUNDS")

    // I-6: a FAILED transfer carries no ledger entries.
    const strayEntries = await prisma.ledgerEntry.count({
      where: { transferId: failed[0]?.id ?? "" },
    })
    expect(strayEntries).toBe(0)
  })

  it("S-3: a caller cannot spend an account they do not own", async () => {
    const victim = await newUser()
    const attacker = await newUser()
    const recipient = await newUser()
    await fund(victim.accountId, 1_000_000n)

    // The previous version only sent from the attacker's own empty account and
    // asserted INSUFFICIENT_FUNDS — true of any unfunded caller, and evidence
    // of nothing about ownership. A reviewer patched the adapter to honour a
    // client-supplied sender id, drained the victim for a 201, and this test
    // stayed green.
    //
    // These bodies each try to name someone else. All must be ignored: the
    // sender comes from the token or from nowhere.
    for (const injection of [
      { senderUserId: victim.accountId },
      { fromAccountId: victim.accountId },
      { accountId: victim.accountId },
      { userId: victim.accountId },
    ]) {
      const injected = await request(attacker.app)
        .post("/api/transfers")
        .set("authorization", `Bearer ${attacker.token}`)
        .set("idempotency-key", randomUUID())
        .send({ phone: recipient.phone, amount: "300000", ...injection })

      // `strictObject` refuses the unknown field outright; even if it were
      // accepted, nothing in the service reads one.
      expect(injected.status).not.toBe(201)
      expect([400, 422]).toContain(injected.status)
    }

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
    const transfers = new TransferService({ prisma, pepper: "test-pepper" })

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

describe.skipIf(!hasDatabase)("FR-6 limits, each with its own test", () => {
  let prisma: PrismaClient
  let treasuryAccountId: string

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    treasuryAccountId = (await seed(prisma)).accountId
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  /** Registers a holder and, if asked, funds it straight from the treasury. */
  async function holder(funded: bigint) {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "T", lastName: "H", password: PASSWORD })
    const account = await prisma.account.findFirstOrThrow({ where: { user: { phone } } })

    if (funded > 0n) {
      await prisma.$transaction(async (tx) => {
        // Lock before reading, as `fund` above and `TransferService.topUp` do.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:treasury'))`

        const treasury = await tx.account.findUniqueOrThrow({ where: { id: treasuryAccountId } })
        const transfer = await tx.transfer.create({
          data: {
            fromAccountId: treasuryAccountId,
            toAccountId: account.id,
            initiatedBy: account.userId,
            amount: funded,
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
            amount: -funded,
            balanceAfter: treasury.balance - funded,
          },
          {
            accountId: account.id,
            transferId: transfer.id,
            amount: funded,
            balanceAfter: account.balance + funded,
          },
        ])
        await tx.account.update({
          where: { id: treasuryAccountId },
          data: { balance: treasury.balance - funded },
        })
        await tx.account.update({ where: { id: account.id }, data: { balance: funded } })
        await tx.transfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        })
      })
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { phone } })
    return { app, phone, userId: user.id, accountId: account.id, token: res.body.accessToken }
  }

  it("FR-6.2: the new-recipient cap is a 24-hour total, not a per-transfer ceiling", async () => {
    // Capping each transfer left the real ceiling at the daily limit -
    // 30 000 000 UZS rather than 500 000, sixty times the clause, on the one
    // control 17.2 names against an account-takeover drain. Four transfers of
    // exactly the cap went straight through.
    const sender = await holder(300_000_000n)
    const stranger = await holder(0n)
    const transfers = new TransferService({ prisma, pepper: "test-pepper" })

    // 400 000 UZS: under the cap, accepted.
    await transfers.execute({
      senderUserId: sender.userId,
      recipientPhone: stranger.phone,
      amount: 40_000_000n,
      idempotencyKey: randomUUID(),
      channel: "WEB",
    })

    // Another 200 000 would take the 24-hour total to 600 000, over the cap.
    await expect(
      transfers.execute({
        senderUserId: sender.userId,
        recipientPhone: stranger.phone,
        amount: 20_000_000n,
        idempotencyKey: randomUUID(),
        channel: "WEB",
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      details: [{ path: ["amount"], code: "limit.new_recipient" }],
    })
  })

  it("FR-6.3: more than five transfers in five minutes blocks", async () => {
    const sender = await holder(10_000_000n)
    const transfers = new TransferService({ prisma, pepper: "test-pepper" })
    const recipients = []
    for (let i = 0; i < 6; i++) recipients.push(await holder(0n))

    const outcomes: string[] = []
    for (const recipient of recipients) {
      try {
        await transfers.execute({
          senderUserId: sender.userId,
          recipientPhone: recipient.phone,
          amount: 100_000n,
          idempotencyKey: randomUUID(),
          channel: "WEB",
        })
        outcomes.push("ok")
      } catch (error) {
        outcomes.push((error as { details?: { code: string }[] }).details?.[0]?.code ?? "other")
      }
    }

    expect(outcomes.slice(0, 5)).toEqual(["ok", "ok", "ok", "ok", "ok"])
    expect(outcomes[5]).toBe("limit.velocity")
  })

  /**
   * FR-2.8 applies to every WEB transfer above a million so'm, which most of
   * the limit tests below exceed on purpose. The password is the one these
   * holders were registered with; passing it keeps these tests about the
   * limits they are named for rather than about the step-up.
   */
  const stepUp = { password: PASSWORD }

  it("FR-6.1: the daily total is capped per channel", async () => {
    const sender = await holder(3_500_000_000n)
    const recipient = await holder(0n)
    const transfers = new TransferService({ prisma, pepper: "test-pepper" })

    // An established relationship, so FR-6.2 does not fire before FR-6.1: one
    // small transfer, back-dated past the 24-hour new-recipient window.
    await transfers.execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: 100_000n,
      idempotencyKey: randomUUID(),
      channel: "WEB",
    })
    await prisma.transfer.updateMany({
      where: { fromAccountId: sender.accountId },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    })

    // Three transfers of 10 000 000 UZS reach the 30 000 000 daily cap. Their
    // timestamps are moved back after each one so velocity does not fire
    // first; the daily window is 24 hours, so they still count.
    for (let i = 0; i < 3; i++) {
      await transfers.execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: 1_000_000_000n,
        idempotencyKey: randomUUID(),
        channel: "WEB",
        ...stepUp,
      })
      // Only the ones just made: back-dating everything would drag the
      // relationship-establishing transfer back inside the 24-hour window and
      // let FR-6.2 fire before FR-6.1, which is what this test is not about.
      await prisma.transfer.updateMany({
        where: {
          fromAccountId: sender.accountId,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      })
    }

    await expect(
      transfers.execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: 100_000n,
        idempotencyKey: randomUUID(),
        channel: "WEB",
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      details: [{ path: ["amount"], code: "limit.daily" }],
    })
  })

  it("FR-4.4: a key past its retention is retired, and says so", async () => {
    // The defect was that it answered 500 INTERNAL — "the operation was not
    // performed" — for a key whose transfer had completed. It now answers 409,
    // which is in the catalogue and is not retryable: the transfer row keeps
    // the key permanently, so a key is single-use for good. A client generates
    // a fresh UUID per request, so reusing one a day later is a client bug and
    // deserves a client error.
    const sender = await holder(10_000_000n)
    const recipient = await holder(0n)
    const transfers = new TransferService({ prisma, pepper: "test-pepper" })
    const key = randomUUID()

    await transfers.execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: 100_000n,
      idempotencyKey: key,
      channel: "WEB",
    })

    await prisma.idempotencyRecord.update({
      where: { userId_key: { userId: sender.userId, key } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await expect(
      transfers.execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: 100_000n,
        idempotencyKey: key,
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
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
    /*
     * One aggregate, not one query per account.
     *
     * This used to call `balanceOf` in a loop, which is `LedgerRepository`'s
     * single-account read used N times — correct, and O(N) round trips against
     * a table that only grows. It began timing out at five seconds once the
     * development database held a few dozen accounts, and the honest reading
     * of that is not "the timeout is too low": a whole-database invariant
     * check should not scale with round trips at all.
     *
     * `groupBy` omits accounts with no entries, so they are compared against
     * zero rather than skipped — an account holding a balance with an empty
     * journal is precisely the drift I-4 exists to catch, and a `Map` lookup
     * that quietly returns `undefined` would step over it.
     */
    const accounts = await prisma.account.findMany({ select: { id: true, balance: true } })
    const sums = await prisma.ledgerEntry.groupBy({
      by: ["accountId"],
      _sum: { amount: true },
    })

    const derived = new Map(sums.map((row) => [row.accountId, row._sum.amount ?? 0n]))

    for (const account of accounts) {
      expect(account.balance, `account ${account.id} drifted`).toBe(derived.get(account.id) ?? 0n)
    }
  })
})
