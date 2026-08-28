import { RATES_TTL_MINUTES, type Rate } from "@wallet/shared"
import type { RateFetcher } from "../infra/cbu.js"
import { DomainError } from "./errors.js"

/**
 * FR-7.2's cache, and the degradation rule that is the whole point of it.
 *
 * Three states, and the difference between them is what the user is told:
 *
 * - inside the hour → serve the cache, `stale: false`
 * - past the hour, upstream answers → serve the new values, `stale: false`
 * - past the hour, upstream silent → serve the old values, `stale: true`
 *
 * The third is the one FR-7.2 exists for and the one that is easy to get
 * wrong in the direction that lies: showing yesterday's rate without saying so
 * is worse than showing nothing, because the number looks exactly as
 * authoritative as a fresh one.
 */

export interface RatesSnapshot {
  readonly rates: readonly Rate[]
  readonly fetchedAt: Date
  readonly stale: boolean
}

export interface RatesServiceDependencies {
  readonly fetcher: RateFetcher
  readonly now?: () => Date
  readonly ttlMinutes?: number
}

export class RatesService {
  readonly #fetch: RateFetcher
  readonly #now: () => Date
  readonly #ttlMs: number

  /**
   * In this process, and lost when it restarts.
   *
   * That is a real limitation rather than an oversight, and it bites hardest
   * where P-27 already bites: a free-tier instance sleeps, wakes with an empty
   * cache, and if the central bank is unreachable at that moment there is no
   * "last known value" to fall back to — the fallback FR-7.2 promises exists
   * only for a process that has been running. Surviving a restart means a row
   * in the database, which is a schema change and therefore a decision to take
   * deliberately rather than to slip in beside a widget.
   */
  #cached: RatesSnapshot | null = null

  /**
   * One in-flight request at a time.
   *
   * Without this, the first ten callers after the hour expires each open their
   * own connection to the central bank — a stampede that turns one slow
   * upstream into ten held sockets, and does it precisely when the upstream is
   * already struggling.
   */
  #inFlight: Promise<readonly Rate[]> | null = null

  constructor({
    fetcher,
    now = () => new Date(),
    ttlMinutes = RATES_TTL_MINUTES,
  }: RatesServiceDependencies) {
    this.#fetch = fetcher
    this.#now = now
    this.#ttlMs = ttlMinutes * 60 * 1000
  }

  async current(): Promise<RatesSnapshot> {
    const cached = this.#cached
    const now = this.#now()

    if (cached && now.getTime() - cached.fetchedAt.getTime() < this.#ttlMs) {
      // Returned with `stale: false` even though the values are up to an hour
      // old: inside the TTL is the definition of fresh that FR-7.2 sets, and a
      // rate the central bank publishes once a day does not change in an hour.
      return { ...cached, stale: false }
    }

    try {
      this.#inFlight ??= this.#fetch()
      const rates = await this.#inFlight

      const snapshot: RatesSnapshot = { rates, fetchedAt: this.#now(), stale: false }
      this.#cached = snapshot
      return snapshot
    } catch {
      // Deliberately swallowed rather than rethrown. The upstream being down
      // is not an error condition of this API — it is the condition FR-7.2
      // describes — and logging it belongs to the caller that knows the
      // request id.
      if (cached) return { ...cached, stale: true }

      throw new DomainError(
        "RATES_UNAVAILABLE",
        "Exchange rates are temporarily unavailable and none are cached",
      )
    } finally {
      this.#inFlight = null
    }
  }
}
