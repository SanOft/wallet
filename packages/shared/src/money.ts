import * as z from "zod"

interface CurrencyMeta {
  readonly code: string
  readonly symbol: string
  readonly exponent: 0 | 1 | 2 | 3
  readonly displayDecimals: number
  readonly symbolPosition: "prefix" | "suffix"
  readonly groupSeparator: string
  readonly decimalSeparator: string
}

interface TransferLimit {
  readonly min: bigint
  readonly max: bigint
  readonly step?: bigint
}

export const CURRENCIES = {
  UZS: {
    code: "UZS",
    symbol: "so'm",
    exponent: 2,
    displayDecimals: 0,
    symbolPosition: "suffix",
    groupSeparator: " ",
    decimalSeparator: ",",
  },
  USD: {
    code: "USD",
    symbol: "$",
    exponent: 2,
    displayDecimals: 2,
    symbolPosition: "prefix",
    groupSeparator: ",",
    decimalSeparator: ".",
  },
  EUR: {
    code: "EUR",
    symbol: "€",
    exponent: 2,
    displayDecimals: 2,
    symbolPosition: "suffix",
    groupSeparator: ".",
    decimalSeparator: ",",
  },
} as const satisfies Record<string, CurrencyMeta>

export type CurrencyCode = keyof typeof CURRENCIES

export const TRANSFER_LIMITS = {
  UZS: { min: 100_000n, max: 1_000_000_000n, step: 100n },
} as const satisfies Partial<Record<CurrencyCode, TransferLimit>>

export type SupportedCurrency = keyof typeof TRANSFER_LIMITS

/**
 * Anti-fraud limits (FR-6.1, FR-6.2, FR-6.3), in minor units.
 *
 * §12 of the spec says these are "configurable parameters, stored in the DB".
 * They live here for the MVP because both sides need them: the transfer wizard
 * shows the remaining daily allowance before the user commits to an amount
 * (13.5), and a client that had to guess would either block valid transfers or
 * promise ones the server will refuse. Moving them to a table is a v2 change
 * that replaces this constant with a loader, not a redesign.
 */
export const CHANNEL_LIMITS = {
  WEB: { perOperation: 1_000_000_000n, daily: 3_000_000_000n },
  USSD: { perOperation: 50_000_000n, daily: 200_000_000n },
} as const satisfies Record<string, { readonly perOperation: bigint; readonly daily: bigint }>

export type TransferChannel = keyof typeof CHANNEL_LIMITS

/**
 * FR-2.8: above this, a single transfer asks for the password again.
 *
 * The client needs the number to know when to show the field, and the server
 * needs it to know when to demand one — and a client that guessed low would
 * ask for a password the server does not want, while one that guessed high
 * would submit a transfer it cannot complete and lose what the user typed.
 */
export const STEP_UP_THRESHOLD = 100_000_000n

/** FR-6.2: 500 000 UZS to a recipient first seen less than 24 hours ago. */
export const NEW_RECIPIENT_LIMIT = 50_000_000n

/** FR-6.2, FR-6.3: the window both rules measure over. */
export const NEW_RECIPIENT_WINDOW_HOURS = 24
export const VELOCITY_WINDOW_MINUTES = 5

/** FR-6.3: more than this many transfers inside the window blocks. */
export const VELOCITY_MAX_TRANSFERS = 5

/** FR-10.1: one demo top-up is 1 000 000 UZS. */
export const DEMO_TOPUP_AMOUNT = 100_000_000n

/** FR-10.3: at most three top-ups in 24 hours, to curb abuse. */
export const DEMO_TOPUP_MAX_PER_DAY = 3
export const DEMO_TOPUP_WINDOW_HOURS = 24

const CANONICAL_MINOR_RE = /^(0|[1-9]\d*)$/

export const moneySchema = z
  .string()
  .regex(CANONICAL_MINOR_RE, { error: "money.invalid_format" })
  .transform((s) => BigInt(s))

export type Money = z.infer<typeof moneySchema>

export function createTransferAmountSchema(currency: SupportedCurrency) {
  const { min, max, step } = TRANSFER_LIMITS[currency]
  return moneySchema
    .refine((v) => v >= min, { error: "money.below_minimum" })
    .refine((v) => v <= max, { error: "money.above_maximum" })
    .refine((v) => v % step === 0n, { error: "money.invalid_step" })
}

const pow10 = (n: number): bigint => 10n ** BigInt(n)

const group = (digits: string, sep: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep)

export function formatMoney(minor: bigint, currency: CurrencyCode): string {
  const c = CURRENCIES[currency]
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  const scale = pow10(c.exponent)
  const major = abs / scale
  const fractional = abs % scale

  let body = group(major.toString(), c.groupSeparator)
  if (c.displayDecimals > 0) {
    body +=
      c.decimalSeparator +
      fractional.toString().padStart(c.exponent, "0").slice(0, c.displayDecimals)
  }
  if (negative) body = `-${body}`

  return c.symbolPosition === "prefix" ? `${c.symbol} ${body}` : `${body} ${c.symbol}`
}
