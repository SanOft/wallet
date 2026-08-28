import type { PrismaClient } from "@prisma/client"
import { rateSchema } from "@wallet/shared"
import * as z from "zod"
import type { RatesSnapshot, RatesStore } from "../domain/RatesService.js"

/**
 * `RatesStore` over Postgres (P-30).
 *
 * The table holds one row, and the database enforces that rather than trusting
 * this file to — see the CHECK in `20260828103945_rates_snapshot_single_row`.
 */

/** The single legal primary key. Matches the CHECK constraint exactly. */
const ROW_ID = "ROW_ID"

/**
 * Validated on the way out, not merely cast.
 *
 * The column is `Json`, so what comes back is whatever some version of this
 * code once wrote — including a version with a different `Rate` shape. Our own
 * old data is still data of unknown shape, and `respond()` would reject it at
 * the edge anyway; failing here turns that 500 into a cache miss.
 */
const storedSchema = z.array(rateSchema)

export class RatesRepository implements RatesStore {
  readonly #prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma
  }

  async read(): Promise<RatesSnapshot | null> {
    const row = await this.#prisma.ratesSnapshot.findUnique({ where: { id: ROW_ID } })
    if (!row) return null

    const parsed = storedSchema.safeParse(row.payload)
    if (!parsed.success) return null

    return {
      rates: parsed.data,
      fetchedAt: row.fetchedAt,
      /*
       * Always `false` here, and the service decides.
       *
       * Staleness is "older than the TTL *and* the upstream could not be
       * reached", and this layer knows neither. Storing a `stale` flag would
       * be recording a conclusion whose inputs change every minute.
       */
      stale: false,
    }
  }

  async write(snapshot: RatesSnapshot): Promise<void> {
    // Upsert rather than update-or-insert: two instances refreshing at the
    // same moment would otherwise race between the check and the insert, and
    // one of them would fail on the primary key.
    const payload = snapshot.rates.map((rate) => ({ ...rate }))

    await this.#prisma.ratesSnapshot.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, payload, fetchedAt: snapshot.fetchedAt },
      update: { payload, fetchedAt: snapshot.fetchedAt },
    })
  }
}
