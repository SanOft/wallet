import { describe, expect, it } from "vitest"
import { gsm7Septets, toGsm7 } from "../src/gsm7.js"
import { USSD_MAX_SEPTETS } from "../src/ussd.js"

/**
 * The alphabet the USSD channel is actually limited by (3GPP TS 23.038).
 *
 * Here rather than beside the adapter because two sides depend on it now: the
 * adapter, which fits every reply into the budget before sending it, and F7's
 * simulator, which shows the reader what that budget cost. A second
 * implementation in the browser would drift from this one, and the number it
 * displayed would then be a confident lie about a limit the user cannot
 * otherwise see.
 */

describe("the GSM 7-bit alphabet (3GPP TS 23.038)", () => {
  it("transliterates a name it cannot spell rather than replacing it", () => {
    /*
     * `nameSchema` accepts "Иван" and "Gʻafur" by name. Passed through
     * unchanged, either one turns the message into UCS-2 and the 182-septet
     * budget becomes 70 — so the confirmation screen is cut in the middle of
     * the recipient's name. Replaced with `?`, the sender cannot tell who they
     * are paying, which is the entire point of showing it.
     */
    expect(toGsm7("ИВАН И.")).toBe("IVAN I.")
    expect(toGsm7("Gʻafur")).toBe("G'afur")
    expect(gsm7Septets(toGsm7("ИВАН И."))).not.toBeNull()
  })

  it("counts an escaped character as the two septets it costs", () => {
    // `text.length` is not the budget: 182 square brackets is 364 septets and
    // arrives cut in half.
    expect(gsm7Septets("[")).toBe(2)
    expect(gsm7Septets("A")).toBe(1)
  })

  it("reports that a string cannot be measured rather than measuring it as zero", () => {
    expect(gsm7Septets("И")).toBeNull()
  })

  it("keeps an unrepresentable character visible instead of dropping it", () => {
    // Dropping produces a different, plausible-looking name. A `?` says that
    // something was lost.
    expect(toGsm7("你好")).toBe("??")
  })

  it("holds exactly the budget the octet limit allows", () => {
    /*
     * The constant and the counter have to agree, and until now nothing said
     * so: 182 lived here and the function that measures against it lived in
     * the API. A string of 182 basic characters is the largest thing this
     * channel can carry, and the 183rd is one too many — asserted rather than
     * described, because F7 puts this number on screen.
     */
    expect(gsm7Septets("A".repeat(USSD_MAX_SEPTETS))).toBe(USSD_MAX_SEPTETS)
    expect(gsm7Septets("A".repeat(USSD_MAX_SEPTETS + 1))).toBeGreaterThan(USSD_MAX_SEPTETS)
  })
})
