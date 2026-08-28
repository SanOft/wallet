import { useEffect, useState } from "react"

/**
 * How old the number on screen is, and whether anyone can still vouch for it.
 *
 * FR-3.4 asks for the age of a cached balance. The stricter rule this file
 * implements is that a figure is *never* shown without saying when it was
 * true — not only when the app knows it is offline. The two differ in the case
 * that actually loses people money: a tab left open, a network that stopped
 * answering some minutes ago, and a balance that still reads like the present
 * tense. Nothing is wrong on that screen, which is exactly the problem.
 *
 * So there is no threshold to argue about and no "fresh enough" state. The age
 * is always rendered; what changes is whether it is a quiet aside or a warning
 * with a reason attached.
 */

export type Freshness =
  /** Nothing to show yet, and nothing stale either — the first load. */
  | { readonly kind: "loading" }
  /** Asked for, never arrived. The screen must not invent a zero. */
  | { readonly kind: "absent" }
  /** On screen, and the last attempt to confirm it succeeded. */
  | { readonly kind: "current"; readonly asOf: number }
  /**
   * On screen from a previous visit's cache, with a request in flight.
   *
   * Distinct from `unconfirmed` because nothing has failed yet. Collapsing the
   * two would flash "could not reach the server" for the couple of hundred
   * milliseconds every cold start takes — an interface that cries wolf on
   * every launch is one whose warnings stop being read, which costs exactly
   * when a warning is real.
   */
  | { readonly kind: "checking"; readonly asOf: number }
  /** On screen, but the last attempt failed — so this is the past tense. */
  | {
      readonly kind: "unconfirmed"
      readonly asOf: number
      readonly reason: "offline" | "unreachable"
    }

/** The subset of an RTK Query result this depends on. */
export interface QueryLike {
  readonly data?: unknown
  readonly isError: boolean
  readonly isFetching: boolean
  readonly fulfilledTimeStamp?: number | undefined
}

export function freshnessOf(query: QueryLike, online: boolean): Freshness {
  const hasData = query.data !== undefined && query.fulfilledTimeStamp !== undefined

  if (!hasData) return query.isError && !query.isFetching ? { kind: "absent" } : { kind: "loading" }

  const asOf = query.fulfilledTimeStamp as number

  /*
   * Offline counts even when nothing has failed yet.
   *
   * A device that knows it has no network has already told us the number
   * cannot be confirmed; waiting for a request to time out first would leave
   * the screen claiming currency for as long as the timeout lasts, which is
   * precisely the window this exists to close.
   */
  if (!online) return { kind: "unconfirmed", asOf, reason: "offline" }
  if (query.isError) return { kind: "unconfirmed", asOf, reason: "unreachable" }

  return { kind: "current", asOf }
}

/**
 * `navigator.onLine`, kept current.
 *
 * It is a weak signal — it reports a link, not reachability, and a captive
 * portal reads as online — which is why `freshnessOf` treats a failed request
 * as unconfirmed too. Used alone it would be a promise the browser cannot
 * keep; used as one of two inputs it costs nothing and catches the common case
 * a request has not yet been sent to discover.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)

    globalThis.addEventListener("online", goOnline)
    globalThis.addEventListener("offline", goOffline)
    return () => {
      globalThis.removeEventListener("online", goOnline)
      globalThis.removeEventListener("offline", goOffline)
    }
  }, [])

  return online
}

/** Redraw interval for the age. Long enough to be free, short enough to be true. */
const TICK_MS = 15_000

/**
 * Seconds since `asOf`, recomputed as time passes.
 *
 * Without the interval the age is written once and then silently becomes a
 * lie — the most obvious version of the bug this module exists to prevent, and
 * the easiest to ship, because it is correct at the moment it is written.
 */
export function useAgeSeconds(asOf: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (asOf === null) return
    setNow(Date.now())

    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [asOf])

  return asOf === null ? 0 : Math.max(0, Math.floor((now - asOf) / 1000))
}

/**
 * The age in words (§13.2.4's register: plain, no abbreviations).
 *
 * Rounded down, never up. "1 daqiqa oldin" for something 119 seconds old
 * overstates how fresh it is by a whole minute, and every rounding decision in
 * this file leans the same way: toward admitting the data is older.
 */
export function formatAge(seconds: number): string {
  if (seconds < 10) return "hozirgina"
  if (seconds < 60) return `${seconds} soniya oldin`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} daqiqa oldin`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} soat oldin`

  return `${Math.floor(hours / 24)} kun oldin`
}
