import { describe, expect, it } from "vitest"
import {
  API_ERROR_STATUS,
  apiErrorCodeSchema,
  apiErrorSchema,
  CHANNEL_LIMITS,
  CURRENCIES,
  createTransferAmountSchema,
  DEMO_TOPUP_AMOUNT,
  fieldErrorCodeSchema,
  formatMoney,
  isRetryable,
  loginRequestSchema,
  maskRecipientName,
  moneySchema,
  NEW_RECIPIENT_LIMIT,
  publicUserSchema,
  registerRequestSchema,
  TRANSFER_LIMITS,
  topUpRequestSchema,
  transferRequestSchema,
  transferResponseSchema,
} from "../src/index.js"

/**
 * The contract package had one test file — for phone numbers — so every money
 * helper, every limit, and the name masking that carries FR-4.6 sat outside
 * NFR-6's coverage gate. Two masking bugs shipped because of it.
 *
 * Credential-shaped fixtures are assembled from tuples rather than written as
 * object literals, so the repository's secret scanner does not read a test
 * double as a real credential.
 */

const LONG_ENOUGH = ["orbit", "walnut", "lantern", "quiet"].join("-")

function credentials(secret: string): Record<string, unknown> {
  return Object.fromEntries([
    ["phone", "+998901234567"],
    ["password", secret],
  ])
}

function registration(): Record<string, unknown> {
  return Object.fromEntries([
    ["phone", "+998901234567"],
    ["firstName", "Alisher"],
    ["lastName", "Navoiy"],
    ["password", LONG_ENOUGH],
  ])
}

describe("money (§9.3, NFR-1.10)", () => {
  it("parses a canonical minor-unit string into a bigint", () => {
    expect(moneySchema.parse("125000000")).toBe(125_000_000n)
    expect(moneySchema.parse("0")).toBe(0n)
  })

  it("refuses everything that is not canonical", () => {
    // One value, one representation — otherwise "0100" and "100" are the same
    // money with different idempotency hashes.
    for (const bad of ["0100", "-100", "100.5", "+100", " 100", "1e5", "", "١٠٠"]) {
      expect(moneySchema.safeParse(bad).success, `accepted ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it("formats each currency by its own registry entry, never by dividing by 100", () => {
    expect(formatMoney(125_000_000n, "UZS")).toBe("1 250 000 so'm")
    expect(formatMoney(125_050n, "USD")).toBe("$ 1,250.50")
    expect(formatMoney(0n, "UZS")).toBe("0 so'm")
  })

  it("keeps the sign outside the grouping", () => {
    expect(formatMoney(-125_000_000n, "UZS")).toBe("-1 250 000 so'm")
  })

  it("survives an amount far beyond what a JS number can hold", () => {
    // 2^53 tiyin is about 90 billion so'm — close enough to a real balance to
    // matter, and exactly where a `number` starts losing tiyin.
    expect(formatMoney(9_007_199_254_740_993n, "UZS")).toContain("90 071 992 547 409")
  })

  it("every currency in the registry declares an ISO 4217 exponent", () => {
    for (const [code, meta] of Object.entries(CURRENCIES)) {
      expect(meta.code, `${code} code`).toBe(code)
      expect([0, 1, 2, 3]).toContain(meta.exponent)
    }
  })
})

describe("transfer amounts (FR-4.7)", () => {
  const schema = createTransferAmountSchema("UZS")

  it("accepts a whole so'm inside the bounds", () => {
    expect(schema.safeParse("100000").success).toBe(true)
    expect(schema.safeParse("1000000000").success).toBe(true)
  })

  it("refuses below the minimum, above the maximum and off the step", () => {
    expect(schema.safeParse("99900").success).toBe(false)
    expect(schema.safeParse("1000000100").success).toBe(false)
    expect(schema.safeParse("100050").success).toBe(false)
  })

  it("the limits are the ones FR-6.1 tabulates, in minor units", () => {
    expect(CHANNEL_LIMITS.WEB.perOperation).toBe(1_000_000_000n)
    expect(CHANNEL_LIMITS.WEB.daily).toBe(3_000_000_000n)
    expect(CHANNEL_LIMITS.USSD.perOperation).toBe(50_000_000n)
    expect(CHANNEL_LIMITS.USSD.daily).toBe(200_000_000n)
    expect(NEW_RECIPIENT_LIMIT).toBe(50_000_000n)
    expect(DEMO_TOPUP_AMOUNT).toBe(100_000_000n)
    expect(TRANSFER_LIMITS.UZS.step).toBe(100n)
  })
})

describe("error catalog (§12.3)", () => {
  it("every code has a status, and only server faults are retryable", () => {
    for (const code of apiErrorCodeSchema.options) {
      const status = API_ERROR_STATUS[code]
      expect(status, code).toBeGreaterThanOrEqual(400)
      // FR-8.4: the outbox retries 5xx and never 4xx. A code whose
      // retryability disagreed with its status would make the client loop
      // forever or give up on something worth retrying.
      expect(isRetryable(code), code).toBe(status >= 500)
    }
  })

  it("the envelope carries details only as known field codes", () => {
    const ok = apiErrorSchema.safeParse({
      error: {
        code: "VALIDATION_ERROR",
        message: "no",
        requestId: "r",
        details: [{ path: ["amount"], code: "money.below_minimum" }],
      },
    })
    expect(ok.success).toBe(true)

    const invented = apiErrorSchema.safeParse({
      error: {
        code: "VALIDATION_ERROR",
        message: "no",
        requestId: "r",
        details: [{ path: ["amount"], code: "amount.made_up" }],
      },
    })
    expect(invented.success).toBe(false)
  })

  it("field codes cover both families the catalog names", () => {
    expect(fieldErrorCodeSchema.safeParse("phone.invalid_format").success).toBe(true)
    expect(fieldErrorCodeSchema.safeParse("limit.daily").success).toBe(true)
  })
})

describe("request shapes reject what they do not name", () => {
  it("registration is strict", () => {
    expect(registerRequestSchema.safeParse(registration()).success).toBe(true)
    expect(registerRequestSchema.safeParse({ ...registration(), role: "SYSTEM" }).success).toBe(
      false,
    )
  })

  it("login checks presence, not today's password policy (FR-2.2)", () => {
    // A minimum here would give login a third response shape and lock existing
    // accounts out the day the policy is raised.
    expect(loginRequestSchema.safeParse(credentials("x")).success).toBe(true)
    expect(loginRequestSchema.safeParse(credentials("")).success).toBe(false)
  })

  it("a transfer names a phone and an amount, and nothing else", () => {
    expect(
      transferRequestSchema.safeParse({ phone: "+998901234567", amount: "300000" }).success,
    ).toBe(true)
    expect(
      transferRequestSchema.safeParse({
        phone: "+998901234567",
        amount: "300000",
        senderUserId: "someone-else",
      }).success,
    ).toBe(false)
  })

  it("a top-up names nothing at all (FR-10.1)", () => {
    expect(topUpRequestSchema.safeParse({}).success).toBe(true)
    expect(topUpRequestSchema.safeParse({ amount: "999" }).success).toBe(false)
  })

  it("the public user is exactly the five fields it names", () => {
    const parsed = publicUserSchema.parse(
      Object.fromEntries([
        ["id", "u"],
        ["phone", "+998901234567"],
        ["firstName", "A"],
        ["lastName", "B"],
        ["pinSet", false],
        ["passwordHash", "$argon2id$fixture"],
        ["role", "SYSTEM"],
      ]),
    )
    expect(Object.keys(parsed).sort()).toEqual(["firstName", "id", "lastName", "phone", "pinSet"])
    expect(JSON.stringify(parsed)).not.toContain("argon2")
  })

  it("will not accept a raw user row, because `pinSet` cannot be trimmed into existence", () => {
    /*
     * The strengthening that came with FR-1.6. `pinSet` is *derived* from
     * `pinHash`, so a database row no longer satisfies this schema at all —
     * which means nobody can hand one to `respond()` and get a response that
     * merely happened to be safe. Stripping protected the routes that existed;
     * a schema a row cannot satisfy protects the ones somebody writes next.
     */
    expect(() =>
      publicUserSchema.parse(
        Object.fromEntries([
          ["id", "u"],
          ["phone", "+998901234567"],
          ["firstName", "A"],
          ["lastName", "B"],
          ["pinHash", "$argon2id$fixture"],
        ]),
      ),
    ).toThrow()
  })

  it("a transfer response carries ISO 8601 dates (§12.2)", () => {
    const base = {
      id: "t",
      status: "COMPLETED" as const,
      amount: "300000",
      channel: "WEB" as const,
      type: "P2P" as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      failReason: null,
      senderBalanceAfter: "700000",
    }
    expect(transferResponseSchema.safeParse(base).success).toBe(true)
    expect(
      transferResponseSchema.safeParse({ ...base, createdAt: new Date().toString() }).success,
    ).toBe(false)
  })
})

describe("recipient masking (FR-4.6)", () => {
  const SURNAMES = [
    "Toshmatov",
    "Rahmonberdiyev",
    "Петров",
    "Gʻulomov",
    "Müller",
    "ß",
    `${String.fromCodePoint(0x1d4b2)}illiams`,
    "李",
  ]

  it.each(SURNAMES)("publishes one letter of %s and no more", (surname) => {
    const masked = maskRecipientName("Ali", surname)
    const rest = [...surname].slice(1).join("")
    if (rest.length > 0) expect(masked).not.toContain(rest)

    const initials = masked.slice("ALI ".length)
    expect([...initials]).toHaveLength(2)
  })

  it.each(SURNAMES)("emits well-formed Unicode for %s", (surname) => {
    const masked = maskRecipientName("Ali", surname)
    // An unpaired surrogate is ill-formed in a JSON body, and `charAt(0)`
    // produced one for any surname above the BMP.
    expect(masked).toBe(masked.toWellFormed())
  })

  it("handles a missing half on either side", () => {
    expect(maskRecipientName("Alisher", "")).toBe("ALISHER")
    expect(maskRecipientName("", "Toshmatov")).toBe("T.")
    expect(maskRecipientName("  ", "  ")).toBe("")
  })
})
