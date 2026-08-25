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
