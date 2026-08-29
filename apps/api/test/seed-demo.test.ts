import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEMO_USERS, type DemoUser, seedDemoUsers } from "../prisma/seed-demo.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { testEnv } from "./helpers.js"

/**
 * The demo seed, which shipped with a bug this file would have caught.
 *
 * Its first version skipped a user whose row already existed. The first real
 * run registered one of them, threw on the step after it, and the next run saw
 * a user, called it done, and left an account with no PIN and no money that
 * looked seeded. "Idempotent" and "converges" are not the same property, and
 * only one of them is safe for a script whose whole job is to be re-run.
 *
 * **It seeds throwaway numbers, never the real pair.** The first draft of this
 * file created and deleted `+998884615500` and `+998884625500` to get a clean
 * slate, and that was not merely untidy: one of them already existed in the
 * development database as a real account, with a balance and three transfers,
 * registered through the UI. A test that deletes rows by phone number would
 * have destroyed somebody's data to prove a script is idempotent.
 *
 * The numbers below come from the unassigned `+998 33` range the production
 * smoke test already uses (P-26), so a leftover row is recognisable as ours.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

/**
 * Deliberately not `uniquePhone` (P-37).
 *
 * Every other suite was moved onto the shared helper so that one definition of
 * a test number exists. This one stays, because the number is doing a second
 * job here: `+998 33` is unassigned to carriers, so a row left behind by this
 * file is recognisable as a fixture rather than as somebody's account. That
 * matters more here than anywhere else — these tests delete rows *by phone
 * number*, and the header above records what happened when one of them named
 * a real account. `uniquePhone` returns `+9989…`, which looks like a customer.
 */
function throwawayUsers(): readonly DemoUser[] {
  const suffix = Math.floor(1_000_000 + Math.random() * 8_999_999)
  return [
    { phone: `+99833${suffix}`, firstName: "Seed", lastName: "Fixture" },
    { phone: `+99833${suffix + 1}`, firstName: "Seed", lastName: "Fixture" },
  ]
}

describe.skipIf(!hasDatabase)("the demo seed", () => {
  let prisma: PrismaClient
  const users = throwawayUsers()
  const phones = users.map((u) => u.phone)

  beforeAll(() => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("refuses to touch the real accounts by default", () => {
    /*
     * The guard that makes the rest of this file safe. If the default list
     * ever loses its phone numbers — or the tests below lose their argument —
     * this is what says so, rather than a deletion nobody notices.
     */
    expect(DEMO_USERS.map((u) => u.phone)).toEqual(["+998884615500", "+998884625500"])
    expect(phones.every((p) => !DEMO_USERS.some((d) => d.phone === p))).toBe(true)
  })

  it("creates both accounts, funded, with a PIN", async () => {
    const created = await seedDemoUsers(prisma, users)
    expect(created.map((r) => r.created)).toEqual([true, true])

    for (const phone of phones) {
      const user = await prisma.user.findUnique({
        where: { phone },
        select: { pinHash: true, accounts: { select: { balance: true, type: true } } },
      })

      expect(user, phone).not.toBeNull()
      // FR-9.5: without this the USSD channel refuses every step.
      expect(user?.pinHash, `${phone} has no PIN`).toBeTruthy()
      expect(user?.accounts.find((a) => a.type === "USER")?.balance).toBe(100_000_000n)
    }
  })

  it("leaves the money alone on a second run", async () => {
    /*
     * `topUp` takes a fresh idempotency key on every call, so it is not
     * idempotent on its own — an unconditional one would mint another
     * 1 000 000 per reseed, and a demo balance that grows whenever somebody
     * runs a script is a number that means nothing.
     */
    const again = await seedDemoUsers(prisma, users)
    expect(again.map((r) => r.created)).toEqual([false, false])

    const balances = await prisma.account.findMany({
      where: { user: { phone: { in: phones } }, type: "USER" },
      select: { balance: true },
    })
    expect(balances.map((a) => a.balance)).toEqual([100_000_000n, 100_000_000n])
  })

  it("repairs a half-finished run rather than calling it done", async () => {
    /*
     * The actual bug, reproduced: a user with neither a PIN nor money, which
     * is the state the first real run left behind when it threw between
     * `register` and `setPin`.
     */
    const target = phones[0] ?? ""
    const before = await prisma.user.findUniqueOrThrow({ where: { phone: target } })
    await prisma.user.update({ where: { id: before.id }, data: { pinHash: null } })

    await seedDemoUsers(prisma, users)

    const repaired = await prisma.user.findUniqueOrThrow({
      where: { id: before.id },
      select: { pinHash: true },
    })
    expect(repaired.pinHash, "a half-seeded account stayed half-seeded").toBeTruthy()
  })

  it("refuses to run where those credentials would matter", async () => {
    // The password and the PIN are published in the repository. This guard is
    // the only thing standing between that and a real deployment.
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      await expect(seedDemoUsers(prisma, users)).rejects.toThrow(/will not run/)
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})
