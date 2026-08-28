import { RATE_CURRENCIES, type Rate, rateSchema } from "@wallet/shared"
import * as z from "zod"

/**
 * The Central Bank of Uzbekistan's open rates feed (FR-7.1).
 *
 * No authentication and no contract with us: this is somebody else's JSON,
 * fetched over the internet, and it is validated on the way in exactly as a
 * request body is. An upstream that starts returning `Rate: null` should
 * produce a refusal here, not a `null` that reaches a screen and renders as
 * the word "null" where a price belongs.
 */

/** Only the five fields FR-7.1 names; the feed carries a dozen more. */
const upstreamRateSchema = z.object({
  Ccy: z.string(),
  Rate: z.string(),
  Diff: z.string(),
  Nominal: z.string(),
  /** `28.08.2026`. Their format, normalised before it leaves this file. */
  Date: z.string(),
})

const upstreamSchema = z.array(upstreamRateSchema)

export const CBU_RATES_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/"

/**
 * Three seconds.
 *
 * The rates widget is the least important thing on the home screen, and a
 * request that waits thirty seconds for it holds a connection open on a
 * network NFR-3 assumes is bad. Falling back to yesterday's rate immediately
 * is a better answer than today's rate eventually.
 */
const TIMEOUT_MS = 3000

/** What the service depends on, so a test never reaches the internet. */
export type RateFetcher = () => Promise<readonly Rate[]>

function toIsoDate(value: string): string | null {
  // `28.08.2026` → `2026-08-28`. Rejecting rather than guessing: if the feed
  // ever switches to `2026-08-28`, this returns null and the caller refuses,
  // which is visible. Reversing whatever it finds would silently publish
  // `2026-28-08` on a day that parses both ways.
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!match) return null

  const [, day, month, year] = match
  return `${year}-${month}-${day}`
}

export async function fetchCbuRates(): Promise<readonly Rate[]> {
  const response = await fetch(CBU_RATES_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  })

  if (!response.ok) {
    throw new Error(`CBU responded ${response.status}`)
  }

  const wanted = new Set<string>(RATE_CURRENCIES)
  const rates: Rate[] = []

  for (const row of upstreamSchema.parse(await response.json())) {
    if (!wanted.has(row.Ccy)) continue

    const publishedOn = toIsoDate(row.Date)
    if (!publishedOn) throw new Error(`CBU published an unreadable date: ${row.Date}`)

    // Through the shared schema, so the shape that leaves this service is the
    // shape the client's contract describes — checked here rather than trusted
    // from the mapping above.
    rates.push(
      rateSchema.parse({
        currency: row.Ccy,
        rate: row.Rate,
        diff: row.Diff,
        nominal: row.Nominal,
        publishedOn,
      }),
    )
  }

  // An empty result is a failure, not an empty widget: FR-7.1 names two
  // currencies, and a feed that carries neither has changed in a way this code
  // has not been told about.
  if (rates.length === 0) throw new Error("CBU returned no rate for USD or EUR")

  return rates
}
