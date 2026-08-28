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

/**
 * Where the last reading is kept between restarts (P-30).
 *
 * A port declared by the domain and implemented in `infra`, so the policy
 * above can be read and tested without a database — and so the storage can
 * change without the policy noticing (§8.3).
 *
 * Both methods are allowed to fail. The service treats a store that cannot be
 * read as an empty one and a write that fails as done, because the request
 * being served is about exchange rates: a database problem is real, and it is
 * already visible on `/health` and on every endpoint that actually needs the
 * database.
 */
export interface RatesStore {
  read(): Promise<RatesSnapshot | null>
  write(snapshot: RatesSnapshot): Promise<void>
}

/** For tests, and for nothing else: a store that forgets, stated out loud. */
export function memoryRatesStore(): RatesStore {
  let held: RatesSnapshot | null = null
  return {
    read: () => Promise.resolve(held),
    write: (snapshot) => {
      held = snapshot
      return Promise.resolve()
    },
  }
}

export interface RatesServiceDependencies {
  readonly fetcher: RateFetcher
  readonly store: RatesStore
  readonly now?: () => Date
  readonly ttlMinutes?: number
}

export class RatesService {
  readonly #fetch: RateFetcher
  readonly #store: RatesStore
  readonly #now: () => Date
  readonly #ttlMs: number

  /**
   * The hot copy. The durable one is in `#store`, read once on the first miss.
   *
   * Two layers rather than one because they answer different questions: this
   * one keeps a rate request from touching the database at all, and the store
   * keeps FR-7.2's promise across the restarts P-27 makes routine.
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
    store,
    now = () => new Date(),
    ttlMinutes = RATES_TTL_MINUTES,
  }: RatesServiceDependencies) {
    this.#fetch = fetcher
    this.#store = store
    this.#now = now
    this.#ttlMs = ttlMinutes * 60 * 1000
  }

  async current(): Promise<RatesSnapshot> {
    // On the first miss of a process's life, ask the store before the bank.
    // This is the whole of P-30: an instance that wakes to an unreachable
    // upstream still has the reading its predecessor took.
    this.#cached ??= await this.#readStore()

    const cached = this.#cached
    const now = this.#now()

    const age = cached ? now.getTime() - cached.fetchedAt.getTime() : Number.POSITIVE_INFINITY

    /*
     * `age >= 0` is not defensive noise: a reading stamped in the future makes
     * every future comparison pass, so the cache stops expiring and the values
     * freeze permanently. Found by running the app against a database whose
     * row had a tomorrow's timestamp in it — the widget showed the same rate
     * for hours and nothing anywhere said why.
     *
     * The clock does not have to be tampered with for this to happen. The row
     * can be written by another instance, and two machines disagreeing by a
     * few seconds is ordinary; disagreeing by an hour is a misconfigured
     * timezone. A negative age means the value cannot be reasoned about, so it
     * is not treated as fresh — though it is still good enough to fall back to
     * if the upstream is down, which is what `stale` is for.
     */
    if (cached && age >= 0 && age < this.#ttlMs) {
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
      await this.#writeStore(snapshot)
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

  async #readStore(): Promise<RatesSnapshot | null> {
    try {
      return await this.#store.read()
    } catch {
      // An unreadable store is an empty one. The alternative is refusing to
      // serve rates because a cache is broken, which inverts what a cache is
      // for.
      return null
    }
  }

  async #writeStore(snapshot: RatesSnapshot): Promise<void> {
    try {
      await this.#store.write(snapshot)
    } catch {
      // The value is already in hand and already correct; failing the request
      // now would discard a good answer over a bookkeeping error.
    }
  }
}
