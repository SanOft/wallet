import { describe, expect, it } from "vitest"
import { amountTone } from "../src/lib/amountTone.js"

/**
 * A failed transfer must not look like money that arrived.
 *
 * Found in a screenshot: two failed demo top-ups, each rendered as
 * `+ 1 000 000 so'm` in success green, two lines below the word
 * "Bajarilmadi". The balance had not moved. Three screens had each decided
 * the colour and the sign from `direction` alone, and all three were wrong
 * the same way.
 *
 * These assert the rule directly rather than through a rendered row, because
 * it is one rule and there are three consumers — the point of extracting it
 * was that they cannot disagree.
 */

describe("what a failed amount is allowed to look like", () => {
  it("is not the colour of money that arrived", () => {
    const failed = amountTone("incoming", "FAILED")
    const arrived = amountTone("incoming", "COMPLETED")

    expect(arrived.colour).toBe("var(--color-success)")
    expect(failed.colour, "a failed credit is painted as a successful one").not.toBe(arrived.colour)
  })

  it("carries a signal that is not colour (NFR-4)", () => {
    // A colour-blind reader, or anyone glancing at the figure rather than the
    // status word two lines above it, gets nothing from the colour alone.
    expect(amountTone("incoming", "FAILED").struck).toBe(true)
    expect(amountTone("outgoing", "FAILED").struck).toBe(true)
    expect(amountTone("incoming", "COMPLETED").struck).toBe(false)
  })

  it("does not announce a failed credit as income on its own", () => {
    /*
     * The amount is its own element. A screen-reader user moving through the
     * row hears it in isolation, and "kirim 1 000 000" about money that never
     * arrived is the same defect said out loud.
     */
    expect(amountTone("incoming", "FAILED").label).toContain("bajarilmadi")
    expect(amountTone("incoming", "PENDING").label).toContain("kutilmoqda")
    expect(amountTone("incoming", "COMPLETED").label.trim()).toBe("kirim")
  })

  it("does not paint a failure red either", () => {
    /*
     * The obvious fix, and it is also wrong: red beside a debit reads as
     * "you lost this", and a failed transfer is money that never left. The
     * row's status word is already red; the figure is simply de-emphasised.
     */
    expect(amountTone("outgoing", "FAILED").colour).not.toBe("var(--color-danger)")
    expect(amountTone("incoming", "FAILED").colour).toBe("var(--color-text-secondary)")
  })

  it("does not call a pending credit money in hand", () => {
    // It has not arrived. Not struck through either, because it still might.
    const pending = amountTone("incoming", "PENDING")
    expect(pending.colour).not.toBe("var(--color-success)")
    expect(pending.struck).toBe(false)
  })

  it("keeps the direction visible whatever the status", () => {
    // The sign says what kind of movement this was, which stays true even when
    // the movement did not happen. Losing it would make a failed debit and a
    // failed credit indistinguishable.
    for (const status of ["COMPLETED", "PENDING", "FAILED"] as const) {
      expect(amountTone("incoming", status).sign).toBe("+ ")
      expect(amountTone("outgoing", status).sign).toBe("− ")
    }
  })

  it("uses tokens, never a literal colour (§13.2)", () => {
    for (const direction of ["incoming", "outgoing"] as const) {
      for (const status of ["COMPLETED", "PENDING", "FAILED"] as const) {
        expect(amountTone(direction, status).colour).toMatch(/^var\(--color-[a-z-]+\)$/)
      }
    }
  })
})
