import { createTransferAmountSchema, fieldErrorCodeSchema, phoneSchema } from "@wallet/shared"
import { describe, expect, it } from "vitest"
import { fromApi, fromZod, messageFor } from "../src/lib/fieldErrors.js"

/**
 * The claim §13.8.2 makes is that client and server errors come from one
 * source. These check that it is true rather than aspirational: the same code
 * reaches this dictionary from a Zod issue raised in the browser and from a
 * `details[]` entry returned by the API, and renders the same sentence.
 */

describe("every code the contract can produce has a sentence", () => {
  it.each(fieldErrorCodeSchema.options)("%s renders as something a person can act on", (code) => {
    const message = messageFor(code)

    // The failure this catches: a code added to `packages/shared` and never
    // given a message, which reaches the user as "money.invalid_step".
    expect(message).not.toBe(code)
    expect(message.length).toBeGreaterThan(10)
  })

  it("falls back to the code rather than to an empty box", () => {
    // A missing sentence should look wrong, not look like nothing is wrong.
    expect(messageFor("something.new")).toBe("something.new")
  })

  it("quotes limits from the registry, so they cannot drift", () => {
    expect(messageFor("money.below_minimum")).toContain("1 000 so'm")
    expect(messageFor("money.above_maximum")).toContain("10 000 000 so'm")
  })

  it("names the password length the schema actually enforces", () => {
    // The number was 15, not the 8 a reader would assume.
    expect(messageFor("password.too_short")).toContain("15")
  })
})

describe("both halves arrive as the same value", () => {
  it("reads a client-side Zod failure", () => {
    const result = phoneSchema.safeParse("998901234567")
    expect(result.success).toBe(false)
    if (result.success) return

    // The schema's "message" is the code, because that is what it was given.
    expect(result.error.issues[0]?.message).toBe("phone.invalid_format")
  })

  it("keys a Zod failure by field", () => {
    const schema = createTransferAmountSchema("UZS")
    const result = schema.safeParse("50")
    expect(result.success).toBe(false)
    if (result.success) return

    // A top-level failure has an empty path and belongs to no field; the form
    // shows it where the caller decides, not silently under a random label.
    expect(fromZod(result.error)).toEqual({})
  })

  it("reads the server's rejection into the same shape", () => {
    const errors = fromApi([
      { path: ["amount"], code: "limit.daily" },
      { path: ["phone"], code: "phone.unsupported_region" },
    ])

    expect(errors.amount).toContain("Bugungi limit")
    expect(errors.phone).toContain("O'zbekiston")
  })

  it("shows the first fault per field and not a stack of them", () => {
    const errors = fromApi([
      { path: ["amount"], code: "money.below_minimum" },
      { path: ["amount"], code: "money.invalid_step" },
    ])

    // A field carrying three complaints is a field the user stops reading.
    expect(Object.keys(errors)).toEqual(["amount"])
    expect(errors.amount).toContain("Eng kam")
  })

  it("survives an envelope with no details at all", () => {
    // Most §12.3 codes carry none — INSUFFICIENT_FUNDS is about the account,
    // not about a field the user typed wrong.
    expect(fromApi(undefined)).toEqual({})
  })
})
