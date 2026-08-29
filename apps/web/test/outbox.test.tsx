import "fake-indexeddb/auto"

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { BACKOFF_MS, classify, MAX_ATTEMPTS, waitBefore } from "../src/features/outbox/policy.js"
import { clearOutbox, queuedItems } from "../src/lib/outbox.js"
import { clearReadCache, resetReadCacheConnection } from "../src/lib/readCache.js"
import { giveSessionHint } from "./renderApp.js"

/**
 * FR-8.3 and FR-8.4, and the rule that carries the whole feature: **a 4xx is
 * never retried**.
 *
 * A rejected request is not one that needs another go — it is one the server
 * understood and refused. Repeating it burns the daily allowance, trips the
 * rate limiter, and turns a clear error into a background process the user can
 * neither see nor stop. Everything else here is bookkeeping around that.
 */

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "125000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
  limits: {
    perOperation: "1000000000",
    daily: { limit: "3000000000", spent: "0", remaining: "3000000000" },
  },
}
const HISTORY = { items: [], nextCursor: null }
const RATES = {
  rates: [
    { currency: "USD", rate: "11801.23", diff: "-22.46", nominal: "1", publishedOn: "2026-08-28" },
  ],
  fetchedAt: "2026-08-28T10:00:00.000Z",
  stale: false,
}

interface Reply {
  readonly status: number
  readonly body: unknown
}

let topUpReplies: Array<Reply | "network-failure">
let topUpCalls: Array<{ key: string | null; authorization: string | null }>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(async () => {
  resetRefreshState()
  resetSessionRestore()
  resetReadCacheConnection()
  await clearReadCache()
  await clearOutbox()
  giveSessionHint()
  window.history.pushState({}, "", "/")

  topUpReplies = []
  topUpCalls = []

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    /*
     * Resolved against the document, exactly as the browser does.
     *
     * `new Request("/api/...")` throws in jsdom without a base, and the throw
     * happens inside the stub — so a relative fetch looked to the code under
     * test like a network failure, and the outbox dutifully retried a request
     * it had never made. The production call is relative because that is what
     * a browser wants; the double has to match the browser, not the reverse.
     */
    const request =
      input instanceof Request
        ? // Already absolute, and already carrying its headers. Rebuilding it
          // from the URL alone drops them — which made an authenticated
          // request look unauthenticated to this double and nothing else.
          input
        : new Request(
            new URL(input instanceof URL ? input.href : input, window.location.href),
            init,
          )
    const url = new URL(request.url).pathname

    if (url === "/api/accounts/topup") {
      topUpCalls.push({
        key: request.headers.get("idempotency-key"),
        authorization: request.headers.get("authorization"),
      })
      const reply = topUpReplies.shift() ?? "network-failure"
      return reply === "network-failure"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(json(reply.body, reply.status))
    }

    if (url === "/api/auth/refresh") return Promise.resolve(json({ accessToken: "s", user: null }))
    if (url === "/api/accounts") return Promise.resolve(json(ACCOUNTS))
    if (url === "/api/transfers") return Promise.resolve(json(HISTORY))
    if (url === "/api/rates") return Promise.resolve(json(RATES))
    return Promise.resolve(json({}))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function showHome() {
  render(<App />)
  await screen.findByRole("heading", { name: "Wallet", level: 1 })
  return screen.findByRole("button", { name: /demo to'ldirish/i })
}

/**
 * §18.2 **S-9**: "offline transfer → online → sent automatically → COMPLETED;
 * no retry on 4xx".
 *
 * Split across two files, deliberately rather than by accident. The refusal
 * half and the round trip are here. The half that matters most — that a queued
 * transfer is never described to the user as one that happened — lives in
 * `transfer.test.tsx`, beside the wizard that would otherwise say so.
 */
describe("the retry policy on its own (FR-8.4)", () => {
  it("never retries anything the server understood and refused", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classify(status, null).kind).toBe("rejected")
    }
  })

  it("does not retry a rate limit either, and that is a choice", () => {
    /*
     * 429 is the arguable one: the server is asking for a delay rather than
     * refusing. But this queue drains with nobody watching, and a client that
     * answers "too many requests" with more requests is the behaviour rate
     * limiting exists to stop.
     */
    expect(classify(429, "RATE_LIMITED").kind).toBe("rejected")
  })

  it("retries what nobody answered, and what the server broke on", () => {
    expect(classify(null, null).kind).toBe("retryable")
    for (const status of [500, 502, 503, 504]) {
      expect(classify(status, null).kind).toBe("retryable")
    }
  })

  it("waits 1, 2, 4, 8 seconds and then gives up", () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 4000, 8000])
    expect(MAX_ATTEMPTS).toBe(5)
    expect(waitBefore(1)).toBe(1000)
    expect(waitBefore(4)).toBe(8000)
    // A fifth attempt has nothing after it. Stopping is the point: a queue
    // that retries forever is a process nobody can see or stop.
    expect(waitBefore(5)).toBeNull()
  })
})

describe("a top-up that cannot be sent", () => {
  it("is queued rather than lost, and says so without claiming it happened", async () => {
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)

    // "Done" would be a promise made for a request that was never sent.
    expect(await screen.findByText(/navbatga qo'yildi/i)).toBeInTheDocument()
    expect(screen.queryByText(/bajarildi/i)).not.toBeInTheDocument()

    const queued = await queuedItems()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.status).toBe("queued")
    // Nothing was sent: there was nowhere to send it.
    expect(topUpCalls).toHaveLength(0)
  })

  it("appears on the screen as queued, not as a transaction", async () => {
    const button = await showHome()
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)

    const queuedSection = await screen.findByRole("region", { name: /yuborilmaganlar/i })
    // The word, not only the colour: a grey row and a black row are the same
    // row to anyone who cannot tell them apart.
    expect(queuedSection).toHaveTextContent(/navbatda/i)
  })

  it("keeps its key when the network comes back, so a retry is not a second top-up", async () => {
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)
    const queued = await queuedItems()
    const key = queued[0]?.key

    topUpReplies = [{ status: 201, body: { id: "t1" } }]
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    window.dispatchEvent(new Event("online"))

    await waitFor(() => expect(topUpCalls).toHaveLength(1))
    /*
     * The same key the queue was written with. A retry that mints a fresh one
     * is a second top-up, and the server has no way to know it was not meant.
     */
    expect(topUpCalls[0]?.key).toBe(key)
    await waitFor(async () => expect(await queuedItems()).toHaveLength(0))
  })

  it("sends it authenticated, like every other request", async () => {
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)

    topUpReplies = [{ status: 201, body: { id: "t1" } }]
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    window.dispatchEvent(new Event("online"))

    await waitFor(() => expect(topUpCalls).toHaveLength(1))

    /*
     * The first version of the sender called `fetch` by hand and set three
     * headers, forgetting this one. Every queued send went out
     * unauthenticated, came back 401, and was filed as permanently rejected —
     * an outbox that could never succeed, behind a green suite, because the
     * double did not check authorisation. A browser found it in one click.
     */
    expect(topUpCalls[0]?.authorization).toMatch(/^Bearer .+/)
  })

  it("stops promising a future for something that has happened", async () => {
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)
    expect(await screen.findByText(/navbatga qo'yildi/i)).toBeInTheDocument()

    topUpReplies = [{ status: 201, body: { id: "t1" } }]
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    window.dispatchEvent(new Event("online"))

    // "It will be sent when the connection returns", sitting under a balance
    // that has already changed, is a small lie of exactly the kind this screen
    // exists to avoid.
    await waitFor(() => expect(screen.queryByText(/navbatga qo'yildi/i)).not.toBeInTheDocument())
  })
})

describe("a queued request the server refuses", () => {
  it("is never sent again, and the reason is on screen", async () => {
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)

    topUpReplies = [{ status: 422, body: { error: { code: "LIMIT_EXCEEDED" } } }]
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    window.dispatchEvent(new Event("online"))

    await waitFor(() => expect(topUpCalls).toHaveLength(1))
    await waitFor(async () => {
      const items = await queuedItems()
      expect(items[0]?.status).toBe("failed")
    })

    // "Try again" is wrong advice for a limit that resets tomorrow, and
    // retrying it would spend the allowance the user has already lost.
    expect(await screen.findByText(/ertaga qayta urinib/i)).toBeInTheDocument()

    window.dispatchEvent(new Event("online"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(topUpCalls).toHaveLength(1)
  })
})

describe("a queued request nobody answers", () => {
  it("gives up after five attempts rather than retrying forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const button = await showHome()

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))
    await userEvent.click(button)

    // Every attempt fails at the transport layer: the queue's own condition.
    topUpReplies = []
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    window.dispatchEvent(new Event("online"))

    await vi.waitFor(() => expect(topUpCalls.length).toBeGreaterThanOrEqual(1))

    // 1s + 2s + 4s + 8s of backoff, and then nothing more.
    for (const wait of BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(wait + 50)
    }

    await vi.waitFor(async () => {
      const items = await queuedItems()
      expect(items[0]?.status).toBe("failed")
      expect(items[0]?.failReason).toBe("exhausted")
    })
    expect(topUpCalls).toHaveLength(MAX_ATTEMPTS)

    await vi.advanceTimersByTimeAsync(60_000)
    // Stopped means stopped.
    expect(topUpCalls).toHaveLength(MAX_ATTEMPTS)
    vi.useRealTimers()
  })
})
