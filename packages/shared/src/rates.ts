import * as z from "zod"

/**
 * `GET /api/rates` — FR-7.
 *
 * Informational only (FR-7.3): nothing in this product converts money, and the
 * moment something does, these numbers stop being a widget and become a price,
 * which is a different contract with a different staleness tolerance.
 */

/** FR-7.1. RUB and GBP are in the upstream feed and deliberately not here. */
export const RATE_CURRENCIES = ["USD", "EUR"] as const
export const rateCurrencySchema = z.enum(RATE_CURRENCIES)
export type RateCurrency = z.infer<typeof rateCurrencySchema>

export const rateSchema = z.object({
  currency: rateCurrencySchema,
  /**
   * UZS for `nominal` units, as a decimal string.
   *
   * A string for the reason §9.3 gives about money: `11801.23` as a float is
   * not `11801.23`, and a rate that renders as `11801.229999999999` reads as a
   * bug in the wallet rather than in IEEE 754. Nothing arithmetic happens to
   * it here — FR-7.3 — so a string is also the whole of what it needs to be.
   */
  rate: z.string(),
  /** Change against the previous publication, signed, same format as `rate`. */
  diff: z.string(),
  nominal: z.string(),
  /**
   * The date the central bank published this rate, as `YYYY-MM-DD`.
   *
   * Normalised from the upstream's `28.08.2026`. §12.2 makes every date on
   * this API ISO 8601, and leaving one exception means every client writes a
   * parser for a format only this field uses.
   */
  publishedOn: z.iso.date(),
})
export type Rate = z.infer<typeof rateSchema>

export const ratesResponseSchema = z.object({
  rates: z.array(rateSchema),
  /** When this server last succeeded in reading the upstream. */
  fetchedAt: z.iso.datetime(),
  /**
   * FR-7.2: the cache outlived its hour and the upstream could not be reached,
   * so these are the last known values.
   *
   * A boolean rather than an inference the client draws from `fetchedAt`,
   * because "is this old" is a server-side policy question — the TTL lives
   * here — and two clients computing it from a timestamp will eventually
   * disagree with each other and with the cache.
   */
  stale: z.boolean(),
})
export type RatesResponse = z.infer<typeof ratesResponseSchema>

/** The hour of FR-7.2, in one place both the service and its tests read. */
export const RATES_TTL_MINUTES = 60
