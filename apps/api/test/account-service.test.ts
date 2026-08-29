import type { PrismaClient } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { AccountService, LOOKUP_LIMIT, LOOKUP_WINDOW_MS } from "../src/domain/AccountService.js"
import { DomainError, RecipientNotFoundError } from "../src/domain/errors.js"

/**
 * `AccountService` on its own, with a clock and a Prisma double.
 *
 * The two channels that use it already cover it end to end, and a mutation
 * table proved a single edit here turns both of them red. What that cannot
 * show is the behaviour at the edges of FR-4.9's rule — the twentieth call
 * against the twenty-first, the boundary of the hour, and the order of the
 * budget against the query — because reaching those through HTTP means twenty
 * round trips per assertion and a clock injected three layers up.
 *
 * The Prisma double is deliberately not a full stub. Each test gives it the one
 * answer that test is about, and counts how often it was asked, because "was
 * the database consulted at all" is the assertion for half of these.
 */

interface Recipient {
  readonly phone: string
  readonly firstName: string
  readonly lastName: string
}

function serviceWith(recipient: Recipient | null) {
  let queries = 0
  const prisma = {
    user: {
      findFirst: async () => {
        queries += 1
        return recipient
      },
    },
  } as unknown as PrismaClient

  let now = 0
  const service = new AccountService({ prisma, now: () => now })

  return {
    service,
    queries: () => queries,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const ZULFIYA: Recipient = { phone: "+998901234567", firstName: "Zulfiya", lastName: "Karimova" }

describe("FR-4.9's lookup budget", () => {
  it("admits exactly the budget and refuses the one after it", async () => {
    const { service } = serviceWith(ZULFIYA)

    for (let i = 0; i < LOOKUP_LIMIT; i++) {
      await expect(
        service.lookupRecipient("caller", ZULFIYA.phone),
        `lookup ${i + 1}`,
      ).resolves.toBeDefined()
    }

    await expect(service.lookupRecipient("caller", ZULFIYA.phone)).rejects.toThrow(DomainError)
  })

  it("spends the budget before the query, not after", async () => {
    /*
     * The order is the control. If the query ran first, a refused caller would
     * still cost a database round trip per attempt — and, worse, the answer
     * would take measurably longer for a registered number than an unregistered
     * one, which is the enumeration signal FR-4.9 exists to remove.
     */
    const { service, queries } = serviceWith(ZULFIYA)

    for (let i = 0; i < LOOKUP_LIMIT; i++) await service.lookupRecipient("caller", ZULFIYA.phone)
    expect(queries()).toBe(LOOKUP_LIMIT)

    await expect(service.lookupRecipient("caller", ZULFIYA.phone)).rejects.toThrow(DomainError)
    expect(queries(), "a refused lookup still hit the database").toBe(LOOKUP_LIMIT)
  })

  it("gives each caller their own budget", async () => {
    // Keyed on the caller, so one enumerator cannot lock everybody else out —
    // and cannot borrow somebody else's allowance either.
    const { service } = serviceWith(ZULFIYA)

    for (let i = 0; i < LOOKUP_LIMIT; i++) await service.lookupRecipient("first", ZULFIYA.phone)
    await expect(service.lookupRecipient("first", ZULFIYA.phone)).rejects.toThrow(DomainError)

    await expect(service.lookupRecipient("second", ZULFIYA.phone)).resolves.toBeDefined()
  })

  it("slides rather than resetting on the hour", async () => {
    /*
     * A window that reset every hour on the hour would let a caller spend
     * forty in two minutes across the boundary. Twenty at t=0 are still spent
     * one millisecond before the hour, and released one millisecond after the
     * oldest of them expires.
     */
    const { service, advance } = serviceWith(ZULFIYA)

    for (let i = 0; i < LOOKUP_LIMIT; i++) await service.lookupRecipient("caller", ZULFIYA.phone)

    advance(LOOKUP_WINDOW_MS - 1)
    await expect(service.lookupRecipient("caller", ZULFIYA.phone)).rejects.toThrow(DomainError)

    advance(2)
    await expect(service.lookupRecipient("caller", ZULFIYA.phone)).resolves.toBeDefined()
  })
})

describe("what a lookup discloses", () => {
  it("masks the name inside the domain", async () => {
    /*
     * FR-4.6. Both adapters masked this themselves before the extraction and
     * would have gone on doing so; the point is that the third one cannot
     * forget, because the full surname never leaves this method.
     */
    const { service } = serviceWith(ZULFIYA)

    const match = await service.lookupRecipient("caller", ZULFIYA.phone)
    expect(match.maskedName).toBe("ZULFIYA K.")
    expect(JSON.stringify(match)).not.toContain("Karimova")
  })

  it("answers an unregistered number and the treasury the same way", async () => {
    // `findFirst` is scoped to accounts of type USER, so the treasury is not
    // found — and a caller learns only that they cannot pay it.
    const { service } = serviceWith(null)

    await expect(service.lookupRecipient("caller", "+998900000000")).rejects.toThrow(
      RecipientNotFoundError,
    )
  })

  it("still charges for a lookup that found nothing", async () => {
    /*
     * Otherwise the budget is only spent on hits, and an enumerator walking a
     * range — who by definition mostly misses — would never reach it. That is
     * precisely the caller the cap is for.
     */
    const { service } = serviceWith(null)

    for (let i = 0; i < LOOKUP_LIMIT; i++) {
      await expect(service.lookupRecipient("caller", "+998900000000")).rejects.toThrow(
        RecipientNotFoundError,
      )
    }

    await expect(service.lookupRecipient("caller", "+998900000000")).rejects.toThrow(DomainError)
  })
})
