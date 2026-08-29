import { describe, expect, it } from "vitest"
import { CHANNEL_LIMITS, TRANSFER_LIMITS } from "../src/money.js"

/**
 * Which refusals a caller can actually provoke (P-18).
 *
 * FR-4.7 gives a transfer a minimum, a maximum and a step. FR-6.1 gives each
 * channel a per-operation cap. Both are enforced server-side, and in that
 * order: `TransferService` calls `#assertAmountIsSane` and then
 * `#assertWithinLimits` on the next line.
 *
 * On the web the two numbers are identical, so nothing can be at once within
 * FR-4.7's maximum and above FR-6.1's cap — `limit.per_operation` is
 * unreachable on that channel, and an over-large web transfer is refused as
 * `money.above_maximum` instead. That is not a bug. It is a product decision
 * about fraud exposure that P-18 records, and this file exists so the decision
 * cannot be reversed by accident: raise FR-4.7's maximum, or lower the web cap,
 * and one of these fails and says which.
 *
 * The USSD numbers show the same code is live rather than dead: its cap sits
 * well below the maximum, so amounts between them reach the limit check.
 */

describe("§13 limits — which refusal a caller can reach", () => {
  it("makes the per-operation limit unreachable on the web, deliberately", () => {
    /*
     * Equality is the whole claim, so it is asserted as equality rather than as
     * two literals: writing the number twice here would let the constants drift
     * apart while this file kept passing against its own copy.
     */
    expect(CHANNEL_LIMITS.WEB.perOperation).toBe(TRANSFER_LIMITS.UZS.max)
  })

  it("keeps that limit reachable over USSD, so the check is not dead code", () => {
    // Strictly below, so there is a band — 50 000 000 to 1 000 000 000 — where
    // an amount is sane by FR-4.7 and refused by FR-6.1.
    expect(CHANNEL_LIMITS.USSD.perOperation).toBeLessThan(TRANSFER_LIMITS.UZS.max)
  })

  it("leaves every channel's daily allowance above its per-operation cap", () => {
    /*
     * The other way round would make the daily figure the binding one and the
     * per-operation cap unreachable everywhere — the same shape as the web case
     * above, arrived at without anyone deciding it.
     */
    for (const [channel, limits] of Object.entries(CHANNEL_LIMITS)) {
      expect(limits.daily, `${channel}: daily is not above per-operation`).toBeGreaterThan(
        limits.perOperation,
      )
    }
  })

  it("keeps FR-4.7's minimum a whole number of steps", () => {
    // A minimum that is not on the step grid is a minimum no amount can equal,
    // so the first legal transfer would be silently larger than the spec says.
    expect(TRANSFER_LIMITS.UZS.min % TRANSFER_LIMITS.UZS.step).toBe(0n)
  })
})
