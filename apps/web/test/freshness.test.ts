import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatAge, freshnessOf, useAgeSeconds } from "../src/lib/freshness.js"

/**
 * The age, tested where it can be tested exactly.
 *
 * This started as an application-level test: render the home screen, install
 * fake timers, advance three minutes, read the card. It was the wrong level.
 * Fake timers have to be installed before the interval is created, which means
 * before the render, which means the session restore and three fetches also run
 * on a fake clock — and the test spent its time proving that RTK Query can
 * settle under `advanceTimersByTimeAsync` rather than proving that the age
 * updates. It timed out, and then poisoned the test that ran after it.
 *
 * The hook has no such problem, and the property being checked is the same:
 * an age written once and never redrawn is a number that silently stops being
 * true, which is the failure this whole module exists to prevent.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe("useAgeSeconds", () => {
  it("keeps counting after the first render", () => {
    vi.useFakeTimers()
    const asOf = Date.now()

    const { result } = renderHook(() => useAgeSeconds(asOf))
    expect(result.current).toBe(0)

    // Through `act`: the interval sets state, and reading `result.current`
    // before React has flushed that update measures the render before the
    // tick — which is exactly the frozen value this test exists to reject.
    act(() => {
      vi.advanceTimersByTime(3 * 60 * 1000)
    })
    expect(formatAge(result.current)).toBe("3 daqiqa oldin")
  })

  it("stops when there is nothing to age", () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useAgeSeconds(null))
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000)
    })

    // No data means no timestamp, and an hour of ticking would be an hour of
    // renders describing nothing.
    expect(result.current).toBe(0)
  })

  it("never reports a negative age when the clocks disagree", () => {
    vi.useFakeTimers()

    // The server's timestamp is not the device's clock, and phones are wrong
    // by minutes routinely. "-4 daqiqa oldin" is a bug report; zero is a
    // rounding decision.
    const { result } = renderHook(() => useAgeSeconds(Date.now() + 5 * 60 * 1000))
    expect(result.current).toBe(0)
  })
})

describe("formatAge", () => {
  it("rounds down, always", () => {
    // 119 seconds is not "2 daqiqa oldin". Every rounding decision here leans
    // toward admitting the data is older than it looks.
    expect(formatAge(119)).toBe("1 daqiqa oldin")
    expect(formatAge(59)).toBe("59 soniya oldin")
    expect(formatAge(9)).toBe("hozirgina")
    expect(formatAge(60 * 60 - 1)).toBe("59 daqiqa oldin")
    expect(formatAge(60 * 60)).toBe("1 soat oldin")
    expect(formatAge(24 * 60 * 60)).toBe("1 kun oldin")
  })
})

describe("freshnessOf", () => {
  const withData = { data: {}, fulfilledTimeStamp: 1000, isError: false, isFetching: false }

  it("calls data current only when the last attempt succeeded and the device is online", () => {
    expect(freshnessOf(withData, true)).toEqual({ kind: "current", asOf: 1000 })
  })

  it("marks it unconfirmed the moment the device goes offline, before anything fails", () => {
    expect(freshnessOf(withData, false)).toEqual({
      kind: "unconfirmed",
      asOf: 1000,
      reason: "offline",
    })
  })

  it("separates a dead network from a dead server", () => {
    expect(freshnessOf({ ...withData, isError: true }, true)).toEqual({
      kind: "unconfirmed",
      asOf: 1000,
      reason: "unreachable",
    })
  })

  it("is loading while a first request is still out, and absent once it has failed", () => {
    expect(freshnessOf({ data: undefined, isError: false, isFetching: true }, true)).toEqual({
      kind: "loading",
    })
    expect(freshnessOf({ data: undefined, isError: true, isFetching: false }, true)).toEqual({
      kind: "absent",
    })
  })

  it("stays loading while a failed request is being retried", () => {
    // `absent` is a refusal shown to the user. Showing it during a retry that
    // may be about to succeed makes the screen flicker between "broken" and
    // "fine" on a weak connection.
    expect(freshnessOf({ data: undefined, isError: true, isFetching: true }, true)).toEqual({
      kind: "loading",
    })
  })
})
