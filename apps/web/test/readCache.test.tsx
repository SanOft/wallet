import "fake-indexeddb/auto"

import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import {
  clearReadCache,
  readCached,
  resetReadCacheConnection,
  writeCached,
} from "../src/lib/readCache.js"
import { giveSessionHint } from "./renderApp.js"

/**
 * FR-8.2, and the one way this feature can do harm.
 *
 * Keeping the last balance is easy. Keeping it *without lying about when it
 * was true* is the requirement — a value restored from disk and stamped with
 * "now" is worse than no cache at all, because the number looks exactly as
 * current as one that arrived a second ago and there is nothing on the screen
 * to tell them apart.
 *
 * `fake-indexeddb` rather than mocking the cache module: the parts most likely
 * to be wrong are the storage round trip and the validation on the way back,
 * and a mock replaces precisely those.
 */

const HOUR_MS = 60 * 60 * 1000

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "125000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
}

const HISTORY = { items: [], nextCursor: null }
const RATES = {
  rates: [
    { currency: "USD", rate: "11801.23", diff: "-22.46", nominal: "1", publishedOn: "2026-08-28" },
  ],
  fetchedAt: "2026-08-28T10:00:00.000Z",
  stale: false,
}

let answer: (url: string) => Response | "network-failure"

beforeEach(async () => {
  resetRefreshState()
  resetSessionRestore()
  resetReadCacheConnection()
  await clearReadCache()
  giveSessionHint()
  window.history.pushState({}, "", "/")

  answer = (url) => {
    const body =
      url === "/api/auth/refresh"
        ? { accessToken: "session", user: null }
        : url === "/api/accounts"
          ? ACCOUNTS
          : url === "/api/transfers"
            ? HISTORY
            : url === "/api/rates"
              ? RATES
              : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url).pathname
    const reply = answer(url)
    return reply === "network-failure"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(reply)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function balanceCard() {
  return screen.getByRole("region", { name: "Hisobingiz" })
}

describe("what a cached read remembers", () => {
  it("survives a reload with its own age, not with today's date", async () => {
    // Written an hour ago by a previous visit.
    await writeCached("accounts", { data: ACCOUNTS, fetchedAt: Date.now() - HOUR_MS })

    // And the network is gone, so the cache is all there is.
    answer = (url) =>
      url === "/api/auth/refresh"
        ? new Response(JSON.stringify({ accessToken: "session", user: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : "network-failure"

    render(<App />)

    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))
    /*
     * The entire point. `upsertQueryData` would have put this value into RTK
     * Query's cache with `fulfilledTimeStamp: now`, and the line below would
     * read "hozirgina yangilangan" about an hour-old balance — the
     * application asserting something false about money.
     */
    expect(balanceCard()).toHaveTextContent(/1 soat oldingi ma'lumot/)
    expect(balanceCard()).not.toHaveTextContent(/hozirgina/)
  })

  it("says it is checking, not that the server is unreachable, while the request is in flight", async () => {
    await writeCached("accounts", { data: ACCOUNTS, fetchedAt: Date.now() - 5 * 60 * 1000 })

    // A request that never settles: the state every cold start passes through.
    answer = (url) =>
      url === "/api/auth/refresh"
        ? new Response(JSON.stringify({ accessToken: "session", user: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify(ACCOUNTS), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url).pathname
      if (url === "/api/accounts") return new Promise<Response>(() => {})
      return Promise.resolve(answer(url))
    })

    render(<App />)

    await waitFor(() => expect(balanceCard()).toHaveTextContent(/yangilanmoqda/))
    // Nothing has failed yet. Crying "could not reach the server" on every
    // launch is how a warning stops being read.
    expect(balanceCard()).not.toHaveTextContent(/ulanib bo'lmadi/)
    // And still the cached age, not the moment this render happened: every
    // branch that shows a cached value has to keep the same promise.
    expect(balanceCard()).toHaveTextContent(/5 daqiqa oldingi ma'lumot/)
  })

  it("keeps the cached age when the device goes offline as well", async () => {
    await writeCached("accounts", { data: ACCOUNTS, fetchedAt: Date.now() - 2 * HOUR_MS })

    answer = (url) =>
      url === "/api/auth/refresh"
        ? new Response(JSON.stringify({ accessToken: "session", user: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : "network-failure"

    render(<App />)
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      window.dispatchEvent(new Event("offline"))
    })

    // Three code paths can put a cached value on screen — in flight, failed,
    // and offline — and a promise kept by two of them is not kept.
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/2 soat oldingi ma'lumot/))
    expect(balanceCard()).not.toHaveTextContent(/hozirgina/)
  })

  it("hands over to the network the moment it answers", async () => {
    await writeCached("accounts", { data: ACCOUNTS, fetchedAt: Date.now() - HOUR_MS })

    render(<App />)

    await waitFor(() => expect(balanceCard()).toHaveTextContent(/hozirgina yangilangan/))
    expect(balanceCard()).not.toHaveTextContent(/1 soat/)
  })

  it("writes what the network returned, so the next visit has it", async () => {
    render(<App />)
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/hozirgina yangilangan/))

    await waitFor(async () => {
      const record = await readCached("accounts")
      expect(record?.data).toEqual(ACCOUNTS)
    })

    const record = await readCached("accounts")
    // The server's arrival time, not the moment the row was written — those
    // differ by however long IndexedDB took, and the smaller number is the
    // honest one.
    expect(record?.fetchedAt).toBeLessThanOrEqual(Date.now())
  })

  it("treats a record it can no longer parse as a miss", async () => {
    // What an older build might have written, or a half-finished migration.
    await writeCached("accounts", { data: { balance: "125000000" }, fetchedAt: Date.now() })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    answer = (url) =>
      url === "/api/auth/refresh"
        ? new Response(JSON.stringify({ accessToken: "session", user: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : "network-failure"

    render(<App />)

    // A refusal, which is recoverable — not a component reading a property of
    // undefined, which is a white screen.
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/imkoni bo'lmadi/))
    expect(
      consoleError.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("stale-shape"),
      ),
    ).toBe(true)
  })
})

describe("what happens on the way out", () => {
  it("keeps nothing once someone signs out", async () => {
    await writeCached("accounts", { data: ACCOUNTS, fetchedAt: Date.now() })
    await writeCached("history:recent", { data: HISTORY, fetchedAt: Date.now() })

    render(<App />)
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    // Reuse detection, an expired cookie and an explicit sign-out all end here.
    act(() => {
      window.dispatchEvent(new Event("offline"))
    })
    const { signedOut } = await import("../src/features/auth/authSlice.js")
    const { makeStore } = await import("../src/app/store.js")
    const store = makeStore()
    store.dispatch(signedOut())

    /*
     * A security requirement, not tidiness. These records are one person's
     * balance and one person's transfers, and a shared phone is the common
     * case in this market — without this the next person sees the previous
     * person's money on a screen that correctly labels it as theirs.
     */
    await waitFor(async () => {
      expect(await readCached("accounts")).toBeNull()
      expect(await readCached("history:recent")).toBeNull()
    })
  })
})
