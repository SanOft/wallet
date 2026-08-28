import { CURRENCIES, type CurrencyCode } from "@wallet/shared"

/**
 * Narrows the wire's `currency: string` to something `formatMoney` can render.
 *
 * The account schema types this field as a plain string — the database only
 * constrains it to three capitals — so a cast to `"UZS"` would be the client
 * asserting something the contract does not promise. If that assertion were
 * ever wrong the amount would render with the wrong symbol and the wrong
 * number of decimals, which on a money screen is worse than not rendering.
 */
export function knownCurrency(code: string): CurrencyCode | null {
  return code in CURRENCIES ? (code as CurrencyCode) : null
}
