import { useEffect, useState } from "react"
import type * as z from "zod"
import { type Freshness, freshnessOf, useOnline } from "./freshness.js"
import { type ReadCacheKey, readCached, writeCached } from "./readCache.js"
import { reportError } from "./report.js"

/**
 * A query, plus the last answer it gave on a previous visit (FR-8.2).
 *
 * The whole difficulty is the timestamp. RTK Query has `upsertQueryData`,
 * which would put a cached value straight into its store — and stamp it with
 * `fulfilledTimeStamp: now`, so a week-old balance would render under
 * "hozirgina yangilangan". That is not a cosmetic bug: it is the application
 * asserting something false about money, which is the one thing every part of
 * this screen is built to avoid.
 *
 * So the cached value is kept beside the query rather than inside it. The
 * query's cache stays honest, the fallback carries its own `fetchedAt`, and
 * `freshnessOf` is given whichever of the two is actually on screen.
 */

interface QueryResult<T> {
  readonly data?: T | undefined
  readonly isError: boolean
  readonly isFetching: boolean
  readonly fulfilledTimeStamp?: number | undefined
}

export interface CachedQuery<T> {
  /** The network's answer if there is one, otherwise the last one kept. */
  readonly data: T | undefined
  readonly freshness: Freshness
}

export function useCachedQuery<T>(
  key: ReadCacheKey,
  schema: z.ZodType<T>,
  query: QueryResult<T>,
): CachedQuery<T> {
  const online = useOnline()
  const [cached, setCached] = useState<{ data: T; fetchedAt: number } | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Read once per mount. A second read would race the write below and could
  // replace a fresh value with the older one it just superseded.
  useEffect(() => {
    let cancelled = false

    void readCached(key).then((record) => {
      if (cancelled) return

      if (record) {
        /*
         * Validated, not trusted. The record was written by some earlier
         * version of this application, and our own old data is still data of
         * unknown shape — the same reasoning the rates repository uses on the
         * server. A record that no longer parses is a cache miss, which is
         * recoverable, rather than a crash inside a component, which is not.
         */
        const parsed = schema.safeParse(record.data)
        if (parsed.success) setCached({ data: parsed.data, fetchedAt: record.fetchedAt })
        else reportError(`readCache:stale-shape:${key}`, parsed.error)
      }

      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [key, schema])

  // Written whenever the server answers again, and only then: `fulfilledTimeStamp`
  // changes on each new arrival, so this does not fire on re-renders.
  useEffect(() => {
    if (query.data === undefined || query.fulfilledTimeStamp === undefined) return
    void writeCached(key, { data: query.data, fetchedAt: query.fulfilledTimeStamp })
  }, [key, query.data, query.fulfilledTimeStamp])

  const fromNetwork = query.data !== undefined && query.fulfilledTimeStamp !== undefined

  if (fromNetwork) return { data: query.data, freshness: freshnessOf(query, online) }

  if (cached) {
    /*
     * Three different things, and telling them apart is the point.
     *
     * A request still in flight has not failed, so saying "could not reach the
     * server" would be a lie told on every cold start — and a warning shown
     * every launch is a warning nobody reads. Offline and failed are both
     * worth the warning colour, and they differ in what the user can do about
     * them.
     */
    if (!online) {
      return {
        data: cached.data,
        freshness: { kind: "unconfirmed", asOf: cached.fetchedAt, reason: "offline" },
      }
    }

    if (query.isError && !query.isFetching) {
      return {
        data: cached.data,
        freshness: { kind: "unconfirmed", asOf: cached.fetchedAt, reason: "unreachable" },
      }
    }

    return { data: cached.data, freshness: { kind: "checking", asOf: cached.fetchedAt } }
  }

  /*
   * Nothing anywhere. `loaded` keeps this as "loading" until the cache has
   * actually been asked — without it, the first paint of every screen would
   * flash a refusal before the record it already holds arrives.
   */
  if (!loaded) return { data: undefined, freshness: { kind: "loading" } }
  return { data: undefined, freshness: freshnessOf(query, online) }
}

/**
 * Keeps a read without reading it back.
 *
 * The rates widget wants its value written for FR-8.2's inventory but must not
 * restore one: the server's `stale` flag describes whether *it* could reach
 * the central bank when it answered, and a copy sitting on this phone since
 * Tuesday has no honest value for that field. Writing without reading keeps
 * the record available to anything that later knows how to interpret it —
 * without letting today's widget assert something it cannot know.
 */
export function useCachedWrite(key: ReadCacheKey, query: QueryResult<unknown>): void {
  useEffect(() => {
    if (query.data === undefined || query.fulfilledTimeStamp === undefined) return
    void writeCached(key, { data: query.data, fetchedAt: query.fulfilledTimeStamp })
  }, [key, query.data, query.fulfilledTimeStamp])
}
