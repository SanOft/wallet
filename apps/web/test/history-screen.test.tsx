import "fake-indexeddb/auto"

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { clearOutbox } from "../src/lib/outbox.js"
import { clearReadCache, resetReadCacheConnection } from "../src/lib/readCache.js"
import { giveSessionHint } from "./renderApp.js"

/**
 * F5's history screen (FR-5), and the two claims it makes about somebody's
 * money: that this is what happened, and that this is all of it.
 *
 * The second is the one filters can break. A list narrowed by a filter the
 * user cannot see is a list that looks complete and is not — which is why the
 * filters live in the URL, and why an empty result says *why* it is empty.
 */

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "500000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
  limits: {
    perOperation: "1000000000",
    daily: { limit: "3000000000", spent: "0", remaining: "3000000000" },
  },
}

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "t1",
    createdAt: "2026-08-28T09:00:00.000Z",
    status: "COMPLETED",
    type: "P2P",
    channel: "WEB",
    direction: "outgoing",
    amount: "500000",
    counterparty: { maskedName: "ZULFIYA K.", phone: "+998907654321" },
    ...over,
  }
}

/** Every `/api/transfers` request the screen made, with its query string. */
let listCalls: string[]
let pages: Array<{ items: unknown[]; nextCursor: string | null }>
let detail: { status: number; body: unknown }

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
  window.history.pushState({}, "", "/history")

  listCalls = []
  pages = [{ items: [item()], nextCursor: null }]
  detail = { status: 200, body: item() }

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(input instanceof URL ? input.href : input, location.href), init)
    const url = new URL(request.url)

    if (/^\/api\/transfers\/[^/]+$/.test(url.pathname)) {
      return Promise.resolve(json(detail.body, detail.status))
    }

    if (url.pathname === "/api/transfers") {
      listCalls.push(url.search)
      return Promise.resolve(json(pages.shift() ?? { items: [], nextCursor: null }))
    }

    if (url.pathname === "/api/auth/refresh")
      return Promise.resolve(json({ accessToken: "s", user: null }))
    if (url.pathname === "/api/accounts") return Promise.resolve(json(ACCOUNTS))
    if (url.pathname === "/api/rates") {
      return Promise.resolve(
        json({ rates: [], fetchedAt: "2026-08-28T10:00:00.000Z", stale: false }),
      )
    }
    return Promise.resolve(json({}))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function showHistory() {
  render(<App />)
  return screen.findByRole("heading", { name: "Tarix", level: 1 })
}

describe("the list", () => {
  it("shows a row with its direction spoken, not only drawn", async () => {
    await showHistory()

    const row = await screen.findByText("ZULFIYA K.")
    const link = row.closest("a")
    expect(link).toHaveTextContent(/chiqim/)
    expect(link).toHaveTextContent(/5 000 so'm/)
    // Every row is a link to its own detail, which is what makes a transfer
    // something support can be pointed at.
    expect(link).toHaveAttribute("href", "/history/t1")
  })

  it("distinguishes an empty result from one it could not load", async () => {
    pages = [{ items: [], nextCursor: null }]
    await showHistory()

    expect(await screen.findByText(/hali amaliyot yo'q/i)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("says a failure is a failure rather than showing an empty list", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(input instanceof URL ? input.href : input, location.href), init)
      const url = new URL(request.url)
      if (url.pathname === "/api/transfers") return Promise.reject(new TypeError("Failed to fetch"))
      if (url.pathname === "/api/auth/refresh") {
        return Promise.resolve(json({ accessToken: "s", user: null }))
      }
      return Promise.resolve(json(url.pathname === "/api/accounts" ? ACCOUNTS : {}))
    })

    await showHistory()

    // Both are a blank space; one of them says a transfer never happened.
    expect(await screen.findByRole("alert")).toHaveTextContent(/imkoni bo'lmadi/i)
    expect(screen.queryByText(/hali amaliyot yo'q/i)).not.toBeInTheDocument()
  })
})

describe("the filters (FR-5.2)", () => {
  it("put themselves in the URL, so the list can be returned to", async () => {
    await showHistory()
    await screen.findByText("ZULFIYA K.")

    await userEvent.selectOptions(screen.getByLabelText(/yo'nalish/i), "incoming")

    /*
     * A filtered list is a claim about somebody's money. One that cannot be
     * sent to support or returned to after a reload is one they have to
     * reconstruct from memory.
     */
    await waitFor(() => expect(window.location.search).toContain("direction=incoming"))
    await waitFor(() => expect(listCalls.at(-1)).toContain("direction=incoming"))
  })

  it("are read back out of the URL on arrival", async () => {
    window.history.pushState({}, "", "/history?status=FAILED")
    await showHistory()

    // The URL is the state, not a copy of it: arriving with a filter already
    // set must produce the filtered request, or a shared link shows the wrong
    // list.
    await waitFor(() => expect(listCalls.at(-1)).toContain("status=FAILED"))
  })

  it("says why the result is empty when a filter is in force", async () => {
    window.history.pushState({}, "", "/history?status=FAILED")
    pages = [{ items: [], nextCursor: null }]
    await showHistory()

    /*
     * F5's definition of done asks for this state by name. Without it a filter
     * somebody forgot about reads as "your history is gone".
     */
    expect(await screen.findByText(/saralashni o'zgartirib/i)).toBeInTheDocument()
  })
})

describe("paging (FR-5.1)", () => {
  it("adds the next page rather than replacing what is on screen", async () => {
    pages = [
      {
        items: [
          item({ id: "t1", counterparty: { maskedName: "ZULFIYA K.", phone: "+998907654321" } }),
        ],
        nextCursor: "c1",
      },
      {
        items: [
          item({ id: "t2", counterparty: { maskedName: "ALISHER N.", phone: "+998907654321" } }),
        ],
        nextCursor: null,
      },
    ]
    await showHistory()
    await screen.findByText("ZULFIYA K.")

    await userEvent.click(screen.getByRole("button", { name: /yana yuklash/i }))

    // Both, in order. Replacing would lose the rows somebody had just read —
    // and cursor pagination is what makes appending safe, since a transfer
    // arriving meanwhile cannot shift the boundary (§12.2).
    await screen.findByText("ALISHER N.")
    expect(screen.getByText("ZULFIYA K.")).toBeInTheDocument()
    expect(listCalls.at(-1)).toContain("cursor=c1")
  })

  it("offers no next page when the server says there is none", async () => {
    await showHistory()
    await screen.findByText("ZULFIYA K.")

    expect(screen.queryByRole("button", { name: /yana yuklash/i })).not.toBeInTheDocument()
  })

  it("starts the list again when a filter changes", async () => {
    pages = [
      { items: [item()], nextCursor: "c1" },
      { items: [item({ id: "t2" })], nextCursor: null },
      { items: [item({ id: "t3" })], nextCursor: null },
    ]
    await showHistory()
    await screen.findByText("ZULFIYA K.")
    await userEvent.click(screen.getByRole("button", { name: /yana yuklash/i }))
    await waitFor(() => expect(listCalls.at(-1)).toContain("cursor=c1"))

    await userEvent.selectOptions(screen.getByLabelText(/yo'nalish/i), "outgoing")

    // A cursor describes a position in one list. Carrying it into a different
    // one asks the server to continue a list it was never given.
    await waitFor(() => expect(listCalls.at(-1)).not.toContain("cursor="))
  })
})

describe("one transfer on its own (FR-5.3)", () => {
  it("is reachable from a link, not only from the list", async () => {
    window.history.pushState({}, "", "/history/t1")
    render(<App />)

    // Straight to the detail, with no list ever rendered — a reload, or a link
    // pasted into a support conversation.
    expect(await screen.findByRole("heading", { name: "Amaliyot", level: 1 })).toBeInTheDocument()
    expect(await screen.findByText(/t1/)).toBeInTheDocument()
  })

  it("says the same thing whether the transfer is missing or somebody else's", async () => {
    window.history.pushState({}, "", "/history/t9")
    detail = { status: 404, body: { error: { code: "NOT_FOUND", requestId: "r" } } }
    render(<App />)

    /*
     * The server answers both identically so it cannot be an oracle for which
     * ids exist. A screen that guessed which had happened would undo that.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(/topilmadi/i)
  })
})
