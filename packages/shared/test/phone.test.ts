import { describe, expect, it } from "vitest"
import {
  createRegionalPhoneSchema,
  DEFAULT_REGION,
  formatPhone,
  normalizePhone,
  REGIONS,
  SUPPORTED_REGIONS,
} from "../src/phone.js"

/**
 * Acceptance criteria for runbook T-1.1. Written before the fix so the
 * defect is proven, not assumed.
 */

describe("REGIONS registry", () => {
  it("keys are uppercase ISO 3166-1 alpha-2 (FR-1.1)", () => {
    for (const key of Object.keys(REGIONS)) {
      expect(key).toMatch(/^[A-Z]{2}$/)
    }
  })

  it("MVP default and supported set are UZ", () => {
    expect(DEFAULT_REGION).toBe("UZ")
    expect(SUPPORTED_REGIONS).toContain("UZ")
  })

  it("every example agrees with its own callingCode and nationalNumberLength", () => {
    for (const [key, meta] of Object.entries(REGIONS)) {
      expect(meta.example.startsWith(`+${meta.callingCode}`), `${key}.example prefix`).toBe(true)
      expect(meta.example.length, `${key}.example length`).toBe(
        1 + meta.callingCode.length + meta.nationalNumberLength,
      )
    }
  })

  it("displayGroups cover the whole national number", () => {
    for (const [key, meta] of Object.entries(REGIONS)) {
      const covered = meta.displayGroups.reduce((a, b) => a + b, 0)
      expect(covered, `${key}.displayGroups`).toBe(meta.nationalNumberLength)
    }
  })
})

describe("normalizePhone (D-7)", () => {
  const expected = "+998901234567"

  it("prefixes a bare national number", () => {
    expect(normalizePhone("901234567")).toBe(expected)
  })

  it("prefixes a number that already carries the calling code", () => {
    expect(normalizePhone("998901234567")).toBe(expected)
  })

  it("strips spaces", () => {
    expect(normalizePhone("90 123 45 67")).toBe(expected)
  })

  it("strips parentheses, dots and hyphens", () => {
    expect(normalizePhone("(90) 123-45.67")).toBe(expected)
  })

  it("leaves an already-canonical E.164 value untouched", () => {
    expect(normalizePhone(expected)).toBe(expected)
  })

  it("returns the raw input unchanged when it cannot be interpreted", () => {
    expect(normalizePhone("hello")).toBe("hello")
    expect(normalizePhone("123")).toBe("123")
  })

  // Normalization is not validation: a separator-stripped value that is
  // E.164-shaped is passed through even when its length is wrong for the
  // region. createRegionalPhoneSchema is what rejects it.
  it("passes through an E.164-shaped value of the wrong length", () => {
    expect(normalizePhone("+998 90 123")).toBe("+99890123")
  })
})

describe("createRegionalPhoneSchema", () => {
  const schema = () => createRegionalPhoneSchema("UZ")

  it("accepts a canonical UZ number", () => {
    expect(schema().safeParse("+998901234567").success).toBe(true)
  })

  it("rejects the same digits without the plus", () => {
    expect(schema().safeParse("998901234567").success).toBe(false)
  })

  it("rejects a foreign calling code", () => {
    expect(schema().safeParse("+12025550123").success).toBe(false)
  })

  it("rejects a wrong national length", () => {
    expect(schema().safeParse("+99890123456").success).toBe(false)
  })
})

describe("formatPhone", () => {
  it("groups a UZ number per displayGroups", () => {
    expect(formatPhone("+998901234567")).toBe("+998 90 123 45 67")
  })

  it("round-trips with normalizePhone", () => {
    expect(normalizePhone(formatPhone("+998901234567"))).toBe("+998901234567")
  })
})
