import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { isHealthy, reconcile } from "../src/infra/reconciliation.js"
import { testEnv } from "./helpers.js"

/**
 * I-4 and the `balanceAfter` chain, enforced at COMMIT rather than reported
 * the next morning (P-2, P-21).
 *
 * `accounts.balance` is a cache and the journal is the truth. Nothing compared
 * them except `reconcile`, which runs daily — so a drift at 09:00 stayed
 * invisible until the next run, and the transfers built on the wrong number had
 * already happened by then. `balanceAfter` had it worse: §9.2 sells it as
 * making an audit O(1) and nothing validated it at all.
 *
 * These tests write the corruption *directly*, in SQL, with the triggers that
 * would normally prevent it suspended. That is the only way to reach the state
 * being tested: the service cannot produce it, which is the point — the check
 * is here for the write path nobody has written yet, and for a hand-run UPDATE
 * at three in the morning.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDatabase)("the ledger's snapshot and its journal", () => {
  let prisma: PrismaClient
  let treasury: string

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    const seeded = await seed(prisma)
    treasury = seeded.accountId
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  /** A funded account, made the way the application makes one. */
  async function account(balance: bigint): Promise<string> {
    const user = await prisma.user.create({
      data: {
        phone: `+99893${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        firstName: "Ledger",
        lastName: "Fixture",
        passwordHash: "!fixture-cannot-authenticate!",
      },
    })
    const created = await prisma.account.create({
      data: { userId: user.id, currency: "UZS", type: "USER", balance: 0n },
    })
    if (balance > 0n) await moveMoney(treasury, created.id, balance)
    return created.id
  }

  /** One honest transfer, written exactly as `TransferService` writes it. */
  async function moveMoney(from: string, to: string, amount: bigint): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const [fromBefore, toBefore] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { id: from }, select: { balance: true } }),
        tx.account.findUniqueOrThrow({ where: { id: to }, select: { balance: true } }),
      ])

      const transfer = await tx.transfer.create({
        data: {
          fromAccountId: from,
          toAccountId: to,
          initiatedBy: (
            await tx.account.findUniqueOrThrow({ where: { id: to }, select: { userId: true } })
          ).userId,
          amount,
          type: from === treasury ? "TOPUP" : "P2P",
          channel: "WEB",
          idempotencyKey: randomUUID(),
          status: "PENDING",
        },
        select: { id: true },
      })

      await tx.ledgerEntry.createMany({
        data: [
          {
            accountId: from,
            transferId: transfer.id,
            amount: -amount,
            balanceAfter: fromBefore.balance - amount,
          },
          {
            accountId: to,
            transferId: transfer.id,
            amount,
            balanceAfter: toBefore.balance + amount,
          },
        ],
      })

      await tx.account.update({
        where: { id: from },
        data: { balance: fromBefore.balance - amount },
      })
      await tx.account.update({ where: { id: to }, data: { balance: toBefore.balance + amount } })
      await tx.transfer.update({
        where: { id: transfer.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      })

      return transfer.id
    })
  }

  it("accepts a transfer whose snapshot and journal agree", async () => {
    // The control. Without it, a check that rejects everything looks identical
    // to a check that works.
    const from = await account(500_000n)
    const to = await account(0n)

    await expect(moveMoney(from, to, 200_000n)).resolves.toBeDefined()

    const after = await prisma.account.findUniqueOrThrow({ where: { id: to } })
    expect(after.balance).toBe(200_000n)
  })

  it("refuses a snapshot that disagrees with the journal (I-4, P-2)", async () => {
    /*
     * The whole point. Before this check the transaction committed, the user
     * saw the wrong number, and `reconcile` mentioned it the following day —
     * by which time the transfers made against that balance had happened.
     */
    const from = await account(500_000n)
    const to = await account(0n)

    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.transfer.create({
          data: {
            fromAccountId: from,
            toAccountId: to,
            initiatedBy: (
              await tx.account.findUniqueOrThrow({ where: { id: to }, select: { userId: true } })
            ).userId,
            amount: 100_000n,
            type: "P2P",
            channel: "WEB",
            idempotencyKey: randomUUID(),
            status: "PENDING",
          },
          select: { id: true },
        })

        await tx.ledgerEntry.createMany({
          data: [
            { accountId: from, transferId: transfer.id, amount: -100_000n, balanceAfter: 400_000n },
            { accountId: to, transferId: transfer.id, amount: 100_000n, balanceAfter: 100_000n },
          ],
        })

        await tx.account.update({ where: { id: from }, data: { balance: 400_000n } })
        // The lie: the journal says 100 000, the snapshot claims a million.
        await tx.account.update({ where: { id: to }, data: { balance: 1_000_000n } })

        await tx.transfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        })
      }),
    ).rejects.toThrow(/invariant I-4/)

    // And the lie did not survive: a deferred constraint aborts the whole
    // transaction, so neither the balance nor the entries are there.
    const untouched = await prisma.account.findUniqueOrThrow({ where: { id: to } })
    expect(untouched.balance).toBe(0n)
  })

  it("refuses a balanceAfter that is not the running total (P-21)", async () => {
    /*
     * The audit column §9.2 promises. A wrong value here is invisible to every
     * other check — the pair still sums to zero, the amounts still match the
     * transfer — and it poisons every entry written after it, because each one
     * is read as the predecessor of the next.
     */
    const from = await account(500_000n)
    const to = await account(0n)

    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.transfer.create({
          data: {
            fromAccountId: from,
            toAccountId: to,
            initiatedBy: (
              await tx.account.findUniqueOrThrow({ where: { id: to }, select: { userId: true } })
            ).userId,
            amount: 100_000n,
            type: "P2P",
            channel: "WEB",
            idempotencyKey: randomUUID(),
            status: "PENDING",
          },
          select: { id: true },
        })

        await tx.ledgerEntry.createMany({
          data: [
            { accountId: from, transferId: transfer.id, amount: -100_000n, balanceAfter: 400_000n },
            // Correct amount, wrong running total.
            { accountId: to, transferId: transfer.id, amount: 100_000n, balanceAfter: 999_999n },
          ],
        })

        await tx.account.update({ where: { id: from }, data: { balance: 400_000n } })
        await tx.account.update({ where: { id: to }, data: { balance: 999_999n } })

        await tx.transfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        })
      }),
    ).rejects.toThrow(/invariant P-21/)
  })

  it("keeps the chain correct across a run of transfers", async () => {
    /*
     * Induction, exercised rather than argued: each entry is checked against
     * its predecessor when it is written, so a chain built one honest transfer
     * at a time is correct end to end. The assertion reads the column the way
     * §9.2 says an audit would.
     */
    const from = await account(1_000_000n)
    const to = await account(0n)

    for (const amount of [10_000n, 20_000n, 30_000n]) await moveMoney(from, to, amount)

    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: to },
      orderBy: { seq: "asc" },
      select: { amount: true, balanceAfter: true },
    })

    let running = 0n
    for (const entry of entries) {
      running += entry.amount
      expect(entry.balanceAfter).toBe(running)
    }
    expect(running).toBe(60_000n)
  })

  it("still finds a break that was written around the trigger (P-21)", async () => {
    /*
     * The daily job keeps its job. The COMMIT check covers everything written
     * through a transfer from now on; it cannot cover rows that predate this
     * migration, or anything that reaches the table with the triggers
     * suspended — which is exactly how this test produces one, and exactly how
     * a hand-run repair at three in the morning would.
     *
     * Reconciliation was the third thing P-21 named as not validating this
     * column, after the CHECKs and `assert_transfer_balanced`. This is that
     * clause closed.
     */
    const from = await account(300_000n)
    const to = await account(0n)
    await moveMoney(from, to, 100_000n)

    const entry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { accountId: to },
      orderBy: { seq: "desc" },
      select: { id: true },
    })

    // Straight past the append-only trigger, which is the only way in.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'")
      await tx.$executeRawUnsafe(
        'UPDATE "ledger_entries" SET "balanceAfter" = 777 WHERE "id" = $1::uuid',
        entry.id,
      )
    })

    const report = await reconcile(prisma)
    const found = report.chainBreaks.find((b) => b.entryId === entry.id)

    expect(found, "reconcile did not notice a corrupted audit column").toBeDefined()
    expect(found?.claimed).toBe(777n)
    expect(found?.actual).toBe(100_000n)
    expect(isHealthy(report), "a lying audit column is not a healthy ledger").toBe(false)

    // Put it back, so the assertions after this one are about the ledger and
    // not about the mess this test made.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'")
      await tx.$executeRawUnsafe(
        'UPDATE "ledger_entries" SET "balanceAfter" = 100000 WHERE "id" = $1::uuid',
        entry.id,
      )
    })
  })

  it("reports nothing to reconcile, because nothing could have drifted", async () => {
    // The daily job stays — it covers rows written before this migration, and
    // anything a future write path does outside a transfer. It should now be
    // permanently boring.
    const report = await reconcile(prisma)
    expect(report.drifts).toEqual([])
    expect(report.chainBreaks).toEqual([])
    expect(report.globalSum).toBe(0n)
  })
})
