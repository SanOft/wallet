import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { maskRecipientName } from "@wallet/shared"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv } from "./helpers.js"

/**
 * `GET /api/transfers` — FR-5.
 *
 * The tests that matter here are the ones about *position*: a history screen
 * is read while money is arriving, so the interesting failures are a row shown
 * twice and a row never shown at all. Offset pagination produces both, which
 * is why §12.2 forbids it, and a keyset that ignores ties produces the second
 * one alone — invisibly, because the page still looks full.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

function uniquePhone(): string {
  return `+99893${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
}

describe.skipIf(!hasDatabase)("FR-5 — transaction history", () => {
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
    return {
      app,
      phone,
      firstName,
      lastName,
      token: res.body.accessToken as string,
      id: res.body.user.id as string,
    }
  }

  type User = Awaited<ReturnType<typeof newUser>>

  async function topup(user: User) {
    const res = await request(user.app)
      .post("/api/accounts/topup")
      .set("authorization", `Bearer ${user.token}`)
      .set("idempotency-key", randomUUID())
      .send()
    // The body in the message: a bare "expected 400 to be 201" from a helper
    // says which line failed and nothing about why.
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body as { id: string }
  }

  async function send(from: User, to: User, amount: string) {
    const res = await request(from.app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${from.token}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: to.phone, amount })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body as { id: string }
  }

  async function history(user: User, query = "") {
    return request(user.app)
      .get(`/api/transfers${query}`)
      .set("authorization", `Bearer ${user.token}`)
  }

  describe("what a row says (FR-5.3)", () => {
    it("names the counterparty on a transfer and nobody on a top-up", async () => {
      const sender = await newUser("Alisher", "Navoiy")
      const recipient = await newUser("Zulfiya", "Karimova")
      await topup(sender)
      await send(sender, recipient, "100000")

      const mine = await history(sender)
      expect(mine.status).toBe(200)

      const [transfer, credit] = mine.body.items as Array<{
        type: string
        direction: string
        amount: string
        counterparty: { maskedName: string } | null
      }>

      expect(transfer?.type).toBe("P2P")
      expect(transfer?.direction).toBe("outgoing")
      expect(transfer?.counterparty?.maskedName).toBe(maskRecipientName("Zulfiya", "Karimova"))

      // The other side of a top-up is the treasury. Naming it would be
      // describing plumbing to someone who asked where their money came from.
      expect(credit?.type).toBe("TOPUP")
      expect(credit?.direction).toBe("incoming")
      expect(credit?.counterparty).toBeNull()
    })

    it("keeps the amount unsigned and lets the direction carry the sign", async () => {
      const sender = await newUser("Alisher", "Navoiy")
      const recipient = await newUser("Zulfiya", "Karimova")
      await topup(sender)
      await send(sender, recipient, "100000")

      const out = (await history(sender)).body.items[0]
      const inbound = (await history(recipient)).body.items[0]

      // The same transfer, seen from both ends: one number, two directions.
      expect(out.id).toBe(inbound.id)
      expect(out.amount).toBe("100000")
      expect(inbound.amount).toBe("100000")
      expect(out.direction).toBe("outgoing")
      expect(inbound.direction).toBe("incoming")

      // A minus sign on the wire would let one flipped comparison render an
      // incoming payment as a debit.
      expect(inbound.amount.startsWith("-")).toBe(false)
    })

    it("shows the full name masked exactly as the lookup masks it", async () => {
      const sender = await newUser("Alisher", "Navoiy")
      const recipient = await newUser("Zulfiya", "Karimova")
      await topup(sender)
      await send(sender, recipient, "100000")

      const row = (await history(sender)).body.items[0]

      // FR-4.9 pays for this mask on the lookup endpoint, and a different rule
      // here would return what it withholds. What it withholds is the surname.
      expect(row.counterparty.maskedName).not.toContain("Karimova")
    })

    it("returns the number on a row the user sent, and only there", async () => {
      /*
       * P-36. This assertion used to be "no phone number anywhere", which was
       * the right instinct and the wrong rule: the lookup masks the *surname*,
       * and it never withheld the number, because the caller is the one who
       * supplies it. Returning somebody their own typing is not a disclosure,
       * and 13.5's quick pick cannot fill the number field without it.
       *
       * The half that does matter is below, and the old assertion never
       * reached it: the recipient never had the sender's number, so on their
       * copy of the same transfer it stays null.
       */
      const sender = await newUser("Alisher", "Navoiy")
      const recipient = await newUser("Zulfiya", "Karimova")
      await topup(sender)
      await send(sender, recipient, "100000")

      const sent = (await history(sender)).body.items[0]
      expect(sent.direction).toBe("outgoing")
      expect(sent.counterparty.phone).toBe(recipient.phone)

      const received = (await history(recipient)).body.items[0]
      expect(received.direction).toBe("incoming")
      expect(received.counterparty.phone, "the sender's number was disclosed").toBeNull()
      expect(JSON.stringify(received)).not.toContain(sender.phone)
    })
  })

  describe("whose history it is", () => {
    it("never shows a transfer between two other people", async () => {
      const sender = await newUser()
      const recipient = await newUser()
      const stranger = await newUser()
      await topup(sender)
      const moved = await send(sender, recipient, "100000")

      const theirs = await history(stranger)

      expect(theirs.status).toBe(200)
      expect(theirs.body.items).toHaveLength(0)
      expect(JSON.stringify(theirs.body)).not.toContain(moved.id)
    })
  })

  describe("paging a list that is still growing (FR-5.1, §12.2)", () => {
    it("walks every row exactly once across pages", async () => {
      const user = await newUser()
      const other = await newUser()
      await topup(user)
      for (let i = 0; i < 5; i++) await send(user, other, "100000")

      // Six rows: one top-up and five transfers.
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0

      do {
        const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2"
        const page = await history(user, query)
        expect(page.status).toBe(200)

        seen.push(...page.body.items.map((item: { id: string }) => item.id))
        cursor = page.body.nextCursor
        pages++
      } while (cursor && pages < 10)

      expect(seen).toHaveLength(6)
      expect(new Set(seen).size).toBe(6)
      expect(cursor).toBeNull()
    })

    it("is ordered newest first, and stays ordered across the page boundary", async () => {
      const user = await newUser()
      const other = await newUser()
      await topup(user)
      for (let i = 0; i < 3; i++) await send(user, other, "100000")

      const first = await history(user, "?limit=2")
      const second = await history(
        user,
        `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )

      const times = [...first.body.items, ...second.body.items].map((item: { createdAt: string }) =>
        Date.parse(item.createdAt),
      )
      const descending = [...times].sort((a, b) => b - a)
      expect(times).toEqual(descending)
    })

    it("does not lose a row to a tie on createdAt", async () => {
      const user = await newUser()
      const other = await newUser()
      await topup(user)
      await send(user, other, "100000")
      await send(user, other, "200000")

      // Two transfers stamped identically — the case a cursor of `createdAt`
      // alone skips, because the second row is not strictly older than the
      // first. Forced rather than raced: the natural version of this test
      // passes on a slow machine and fails on a fast one.
      const rows = await prisma.transfer.findMany({
        where: { initiatedBy: user.id, type: "P2P" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })
      expect(rows).toHaveLength(2)
      const stamp = new Date("2026-08-20T10:00:00.000Z")
      await prisma.transfer.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { createdAt: stamp },
      })
      // And the top-up pushed behind them, or it becomes the newest row and
      // the two pages under test are no longer the two tied ones.
      await prisma.transfer.updateMany({
        where: { initiatedBy: user.id, type: "TOPUP" },
        data: { createdAt: new Date("2026-08-20T09:00:00.000Z") },
      })

      const first = await history(user, "?limit=1")
      const second = await history(
        user,
        `?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )

      expect(first.body.items[0].id).not.toBe(second.body.items[0].id)
      expect([first.body.items[0].id, second.body.items[0].id].sort()).toEqual(
        rows.map((row) => row.id).sort(),
      )
    })

    it("does not lose a row to a tie across the two directions", async () => {
      const user = await newUser()
      const other = await newUser()
      await topup(user)
      await topup(other)
      await send(user, other, "100000")
      await send(other, user, "100000")

      /*
       * The tie that the previous test cannot produce.
       *
       * Its two rows are both outgoing, so they arrive from one query already
       * ordered by the database, and `Array.sort` being stable preserves that
       * order even with the merge's own tiebreak removed. Here the tied rows
       * come from different scans, so nothing but the tiebreak decides which
       * is "first" — and a page boundary that lands between two rows whose
       * order is arbitrary shows one of them twice and the other never.
       */
      const rows = await prisma.transfer.findMany({
        where: { type: "P2P", OR: [{ initiatedBy: user.id }, { initiatedBy: other.id }] },
        select: { id: true, initiatedBy: true },
      })
      expect(rows).toHaveLength(2)
      await prisma.transfer.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { createdAt: new Date("2026-08-21T10:00:00.000Z") },
      })
      await prisma.transfer.updateMany({
        where: { initiatedBy: { in: [user.id, other.id] }, type: "TOPUP" },
        data: { createdAt: new Date("2026-08-21T09:00:00.000Z") },
      })

      /*
       * Whose history to read is chosen, not assumed.
       *
       * Without the tiebreak the merge keeps scan order, so the *outgoing* row
       * lands first. That only loses the other row when the outgoing id is the
       * smaller of the two, because the next page asks for `id <` it. Reading
       * as whichever party sent the lower-numbered transfer makes the fault
       * deterministic; picking a side in advance made this test a coin flip
       * that had already come up heads once.
       */
      const sentByUser = rows.find((row) => row.initiatedBy === user.id)
      const sentByOther = rows.find((row) => row.initiatedBy === other.id)
      const reader = (sentByUser?.id ?? "") < (sentByOther?.id ?? "") ? user : other

      const first = await history(reader, "?limit=1")
      const second = await history(
        reader,
        `?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )

      expect(first.body.items[0].id).not.toBe(second.body.items[0].id)
      expect([first.body.items[0].id, second.body.items[0].id].sort()).toEqual(
        rows.map((row) => row.id).sort(),
      )
    })

    it("reports no next page on the last one", async () => {
      const user = await newUser()
      await topup(user)

      const only = await history(user)
      expect(only.body.items).toHaveLength(1)
      expect(only.body.nextCursor).toBeNull()
    })
  })

  describe("one transfer on its own (FR-5.3)", () => {
    it("is readable by either party, from their own side of it", async () => {
      const sender = await newUser("Alisher", "Navoiy")
      const recipient = await newUser("Zulfiya", "Karimova")
      await topup(sender)
      const moved = await send(sender, recipient, "100000")

      const asSender = await request(sender.app)
        .get(`/api/transfers/${moved.id}`)
        .set("authorization", `Bearer ${sender.token}`)
      const asRecipient = await request(recipient.app)
        .get(`/api/transfers/${moved.id}`)
        .set("authorization", `Bearer ${recipient.token}`)

      expect(asSender.status).toBe(200)
      expect(asRecipient.status).toBe(200)

      // One transfer, two directions — the same mapping the list uses, which is
      // why they share it. Two implementations would drift on exactly this
      // field, and the drift would render a payment as a debit.
      expect(asSender.body.direction).toBe("outgoing")
      expect(asRecipient.body.direction).toBe("incoming")
      expect(asSender.body.amount).toBe("100000")
      expect(asRecipient.body.amount).toBe("100000")
    })

    it("answers a stranger exactly as it answers a transfer that does not exist", async () => {
      const sender = await newUser()
      const recipient = await newUser()
      const stranger = await newUser()
      await topup(sender)
      const moved = await send(sender, recipient, "100000")

      const someoneElses = await request(stranger.app)
        .get(`/api/transfers/${moved.id}`)
        .set("authorization", `Bearer ${stranger.token}`)
      const imaginary = await request(stranger.app)
        .get("/api/transfers/3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        .set("authorization", `Bearer ${stranger.token}`)

      /*
       * Identical answers on purpose. Telling the two apart would make this an
       * oracle for which transfer ids are real — the same disclosure FR-4.9
       * pays a masked name to avoid.
       */
      expect(someoneElses.status).toBe(404)
      expect(imaginary.status).toBe(404)
      expect(someoneElses.body.error.code).toBe(imaginary.body.error.code)
    })

    it("does not treat a malformed id as a different kind of failure", async () => {
      const user = await newUser()

      const res = await request(user.app)
        .get("/api/transfers/not-a-uuid")
        .set("authorization", `Bearer ${user.token}`)

      expect(res.status).toBe(404)
    })

    it("requires a token", async () => {
      const { app } = buildApp(prisma, { ...process.env })

      const res = await request(app).get("/api/transfers/3f2504e0-4f89-41d3-9a0c-0305e82c3301")

      expect(res.status).toBe(401)
    })
  })

  describe("filters (FR-5.2)", () => {
    it("separates incoming from outgoing", async () => {
      const user = await newUser()
      const other = await newUser()
      await topup(user)
      await send(user, other, "100000")

      const outgoing = await history(user, "?direction=outgoing")
      const incoming = await history(user, "?direction=incoming")

      expect(outgoing.body.items).toHaveLength(1)
      expect(outgoing.body.items[0].type).toBe("P2P")
      expect(incoming.body.items).toHaveLength(1)
      expect(incoming.body.items[0].type).toBe("TOPUP")

      // The filter and the field have to agree. Asserting only the type let a
      // mutation that hard-codes every row to "outgoing" through this test —
      // the rows returned were still the right ones, each labelled wrongly.
      expect(outgoing.body.items[0].direction).toBe("outgoing")
      expect(incoming.body.items[0].direction).toBe("incoming")
    })

    it("bounds by date, inclusively at both ends", async () => {
      const user = await newUser()
      await topup(user)

      const [row] = (await history(user)).body.items as Array<{ createdAt: string }>
      const at = row?.createdAt as string

      const inside = await history(
        user,
        `?from=${encodeURIComponent(at)}&to=${encodeURIComponent(at)}`,
      )
      expect(inside.body.items).toHaveLength(1)

      const after = await history(user, `?from=${encodeURIComponent("2099-01-01T00:00:00.000Z")}`)
      expect(after.body.items).toHaveLength(0)
    })

    it("selects by status", async () => {
      const user = await newUser()
      await topup(user)

      expect((await history(user, "?status=COMPLETED")).body.items).toHaveLength(1)
      expect((await history(user, "?status=FAILED")).body.items).toHaveLength(0)
    })
  })

  describe("what the endpoint refuses", () => {
    it("refuses a page larger than FR-5.1 allows", async () => {
      const user = await newUser()

      const res = await history(user, "?limit=100")

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })

    it("answers a malformed cursor with a field error, not a 500", async () => {
      const user = await newUser()

      const res = await history(user, "?cursor=not-a-real-cursor")

      // A cursor the server did not mint is a client fault. Returning 500
      // would make it look like ours and put it in the wrong log.
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
      expect(res.body.error.details).toContainEqual({ path: ["cursor"], code: "cursor.invalid" })
    })

    it("requires a token", async () => {
      const { app } = buildApp(prisma, { ...process.env })

      const res = await request(app).get("/api/transfers")

      expect(res.status).toBe(401)
    })
  })
})
