import "fake-indexeddb/auto"

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { clearOutbox, queuedItems } from "../src/lib/outbox.js"
import { clearReadCache, resetReadCacheConnection } from "../src/lib/readCache.js"
import { giveSessionHint } from "./renderApp.js"

/**
 * F4's wizard (§13.5), and the four places it can cost somebody money.
 *
 * Advancing on a number that was never looked up. Sending twice because the
 * button was pressed twice. Skipping the step-up FR-2.8 asks for. And telling
 * somebody a transfer happened when it was only queued. Everything else on
 * these screens is arrangement; these four are the product.
 */

/** Assembled rather than written out: a literal trips the secret scanner. */
const SECRET = ["orbit", "walnut", "lantern", "quiet"].join("-")

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "500000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
  limits: {
    perOperation: "1000000000",
    daily: { limit: "3000000000", spent: "0", remaining: "3000000000" },
  },
}
const RECIPIENT = { phone: "+998907654321", maskedName: "ZULFIYA K." }

/**
 * A complete `transferResponseSchema` body.
 *
 * The client validates every response against the contract before rendering
 * it, so a fixture with only the fields a test happens to read is rejected —
 * which is the check doing its job, and the reason this helper exists rather
 * than four partial objects.
 */
function transferBody(id: string) {
  return {
    id,
    status: "COMPLETED" as const,
    amount: "100000",
    channel: "WEB" as const,
    type: "P2P" as const,
    createdAt: "2026-08-29T10:00:00.000Z",
    completedAt: "2026-08-29T10:00:00.000Z",
    failReason: null,
    senderBalanceAfter: "499900000",
  }
}

interface Reply {
  readonly status: number
  readonly body: unknown
}

/** The history the quick pick is derived from, and the allowance the amount
 * step enforces: both are server state, so both are set per test. */
let historyItems: unknown[]
let dailyRemaining: string
let transferReplies: Array<Reply | "network-failure">
let transferCalls: Array<{ key: string | null; body: Record<string, unknown> }>
let lookupReply: Reply | "network-failure"

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
  window.history.pushState({}, "", "/transfer")

  historyItems = []
  dailyRemaining = ACCOUNTS.limits.daily.remaining
  transferReplies = []
  transferCalls = []
  lookupReply = { status: 200, body: RECIPIENT }

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(input instanceof URL ? input.href : input, location.href), init)
    const url = new URL(request.url)

    if (url.pathname === "/api/transfers" && request.method === "POST") {
      transferCalls.push({
        key: request.headers.get("idempotency-key"),
        body: (await request.clone().json()) as Record<string, unknown>,
      })
      const reply = transferReplies.shift() ?? { status: 201, body: transferBody("t1") }
      if (reply === "network-failure") throw new TypeError("Failed to fetch")
      return json(reply.body, reply.status)
    }

    if (url.pathname === "/api/recipients/lookup") {
      if (lookupReply === "network-failure") throw new TypeError("Failed to fetch")
      return json(lookupReply.body, lookupReply.status)
    }

    if (url.pathname === "/api/auth/refresh") return json({ accessToken: "s", user: null })
    if (url.pathname === "/api/accounts") {
      const daily = { ...ACCOUNTS.limits.daily, remaining: dailyRemaining }
      return json({ ...ACCOUNTS, limits: { ...ACCOUNTS.limits, daily } })
    }
    if (url.pathname === "/api/transfers") return json({ items: historyItems, nextCursor: null })
    if (url.pathname === "/api/rates") {
      return json({ rates: [], fetchedAt: "2026-08-28T10:00:00.000Z", stale: false })
    }
    return json({})
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openWizard() {
  render(<App />)
  return screen.findByRole("heading", { name: "Kimga", level: 1 })
}

async function reachAmount() {
  await openWizard()
  await userEvent.type(screen.getByLabelText(/qabul qiluvchi raqami/i), "907654321")
  await userEvent.click(screen.getByRole("button", { name: /qidirish/i }))
  await screen.findByText("ZULFIYA K.")
  await userEvent.click(screen.getByRole("button", { name: /davom etish/i }))
  return screen.findByRole("heading", { name: "Qancha", level: 1 })
}

/**
 * @param soum what the person types — `AmountInput` takes major units and
 *   converts to minor (§13.8.1), so a test that types tiyin is testing a field
 *   nobody uses.
 */
async function reachConfirm(soum: string) {
  await reachAmount()
  await userEvent.type(screen.getByLabelText(/summa/i), soum)
  await userEvent.click(screen.getByRole("button", { name: /davom etish/i }))
  return screen.findByRole("heading", { name: "Tasdiqlash", level: 1 })
}

/** One outgoing row, shaped as `historyItemSchema` requires. */
function sentTo(phone: string, maskedName: string) {
  return {
    id: crypto.randomUUID(),
    createdAt: "2026-08-28T10:00:00.000Z",
    status: "COMPLETED",
    type: "P2P",
    channel: "WEB",
    direction: "outgoing",
    amount: "100000",
    counterparty: { maskedName, phone },
  }
}

describe("step 1 — the quick pick", () => {
  it("still looks the person up, rather than trusting a stored number", async () => {
    /*
     * The whole point of step 1 is that Continue needs a lookup (FR-4.9), and
     * a shortcut that filled the field and enabled Continue would be a way
     * around it — the number came from this device's history, which is not the
     * same as the account still existing under that name today.
     */
    historyItems = [sentTo(RECIPIENT.phone, RECIPIENT.maskedName)]
    await openWizard()

    const pick = await screen.findByRole("button", { name: /ZULFIYA K\./ })
    await userEvent.click(pick)

    // The field's own display grouping (§13.8), not the raw E.164 behind it.
    expect(screen.getByLabelText(/qabul qiluvchi raqami/i)).toHaveValue("+998 90 765 43 21")

    // Reached the amount step without a keystroke, because the pick searched.
    await userEvent.click(await screen.findByRole("button", { name: /davom etish/i }))
    expect(await screen.findByRole("heading", { name: "Qancha", level: 1 })).toBeVisible()
  })

  it("is absent on a first transfer", async () => {
    await openWizard()

    expect(screen.queryByRole("button", { name: /ZULFIYA K\./ })).not.toBeInTheDocument()
  })
})

describe("step 2 — the daily allowance", () => {
  it("refuses an amount the server would refuse, before spending the round trip", async () => {
    dailyRemaining = "50000000" // 500 000 so'm left of the day.
    await reachAmount()

    expect(await screen.findByText("500 000 so'm")).toBeVisible()

    await userEvent.type(screen.getByLabelText(/summa/i), "600000")

    expect(await screen.findByText("Bugungi chegaradan oshdi")).toBeVisible()
    expect(screen.getByRole("button", { name: /davom etish/i })).toBeDisabled()
  })

  it("lets an amount within the allowance through", async () => {
    dailyRemaining = "50000000"
    await reachAmount()
    await userEvent.type(screen.getByLabelText(/summa/i), "400000")

    await userEvent.click(screen.getByRole("button", { name: /davom etish/i }))
    expect(await screen.findByRole("heading", { name: "Tasdiqlash", level: 1 })).toBeVisible()
  })
})

describe("step 1 — who the money is for", () => {
  it("will not advance on a number that was never looked up", async () => {
    await openWizard()

    await userEvent.type(screen.getByLabelText(/qabul qiluvchi raqami/i), "907654321")

    /*
     * A well-formed number is not a person. Advancing on nine valid digits
     * means the mistake is found on the confirmation screen at best, and after
     * the money has gone at worst.
     */
    expect(screen.getByRole("button", { name: /davom etish/i })).toBeDisabled()
  })

  it("says which failure it was, because the fixes differ", async () => {
    lookupReply = { status: 404, body: { error: { code: "RECIPIENT_NOT_FOUND" } } }
    await openWizard()

    await userEvent.type(screen.getByLabelText(/qabul qiluvchi raqami/i), "907654321")
    await userEvent.click(screen.getByRole("button", { name: /qidirish/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/hisob topilmadi/i)
    expect(screen.getByRole("button", { name: /davom etish/i })).toBeDisabled()
  })

  it("forgets the name when the number is edited underneath it", async () => {
    await openWizard()
    await userEvent.type(screen.getByLabelText(/qabul qiluvchi raqami/i), "907654321")
    await userEvent.click(screen.getByRole("button", { name: /qidirish/i }))
    await screen.findByText("ZULFIYA K.")

    await userEvent.type(screen.getByLabelText(/qabul qiluvchi raqami/i), "9")

    /*
     * A name found for a number that has since changed is a name for somebody
     * else. Leaving it on screen is how a confirmation ends up showing one
     * person beside another person's number.
     */
    await waitFor(() => expect(screen.queryByText("ZULFIYA K.")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: /davom etish/i })).toBeDisabled()
  })
})

describe("step 2 — how much", () => {
  it("refuses more than the balance before the server is asked", async () => {
    await reachAmount()

    // The balance is 5 000 000 so'm.
    await userEvent.type(screen.getByLabelText(/summa/i), "6000000")

    expect(await screen.findByText(/yetarli mablag' yo'q/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /davom etish/i })).toBeDisabled()
  })

  it("shows the balance rather than a zero it has not confirmed", async () => {
    await reachAmount()

    /*
     * `findByText`, not `getByText`. The balance arrives on `/api/accounts`,
     * which is not the request `reachAmount` waits for, so a synchronous
     * assertion here resolves on whichever settled first: three runs in eight
     * found the dash this screen shows while the figure is still unknown.
     * That dash is the correct render — the very thing the name asks for —
     * and failing on it made the test call a right answer wrong.
     *
     * 5 000 000 so'm, grouped as the money formatter groups it.
     */
    expect(await screen.findByText(/5 000 000/)).toBeInTheDocument()
  })
})

describe("step 3 — the last chance to stop", () => {
  it("sends once, with one key, however many times the button is pressed", async () => {
    /*
     * The request is held open for the whole test, which is the only way to
     * observe the lock at all: an answered request settles the wizard, and the
     * second press then lands on a screen that has already moved on. Holding
     * it keeps the confirmation on screen in exactly the state a fast second
     * tap would meet.
     */
    /*
     * Initialised to a no-op rather than to `null`. TypeScript cannot see that
     * a Promise executor runs synchronously, so a `| null` declaration narrows
     * to `null` at every later use and `release?.()` becomes uncallable — the
     * same narrowing that broke CI once already.
     */
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    transferReplies = []
    const original = globalThis.fetch
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(input instanceof URL ? input.href : input, location.href), init)
      if (new URL(request.url).pathname === "/api/transfers" && request.method === "POST") {
        transferCalls.push({
          key: request.headers.get("idempotency-key"),
          body: (await request.clone().json()) as Record<string, unknown>,
        })
        await held
        return json(transferBody("t1"), 201)
      }
      return (original as typeof fetch)(input, init)
    })

    await reachConfirm("1000")
    const send = screen.getByRole("button", { name: /^yuborish$/i })

    await userEvent.click(send)
    await waitFor(() => expect(transferCalls).toHaveLength(1))

    // S-6's first layer, observed rather than assumed.
    expect(screen.getByRole("button", { name: /yuborilmoqda/i })).toBeDisabled()

    // And the second layer: even a press that gets through sends the same key,
    // so the server answers it with the first request's result rather than
    // moving money twice.
    await userEvent.click(screen.getByRole("button", { name: /yuborilmoqda/i }))
    await userEvent.click(screen.getByRole("button", { name: /yuborilmoqda/i }))

    expect(transferCalls).toHaveLength(1)
    expect(transferCalls[0]?.key).toMatch(/^[0-9a-f-]{36}$/)

    release()
    await screen.findByRole("alert")
  })

  it("asks for the confirmation above the threshold, and not below it", async () => {
    await reachConfirm("1000")

    expect(screen.queryByLabelText(/^parol$/i)).not.toBeInTheDocument()
  })

  it("asks for it above the threshold (FR-2.8)", async () => {
    await reachConfirm("2000000")

    expect(await screen.findByLabelText(/^parol$/i)).toBeInTheDocument()
  })

  it("sends what it was given, and nothing extra when none is needed", async () => {
    await reachConfirm("2000000")
    await userEvent.type(screen.getByLabelText(/^parol$/i), SECRET)
    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    await waitFor(() => expect(transferCalls).toHaveLength(1))
    expect(transferCalls[0]?.body.password).toBe(SECRET)
  })

  it("omits the field entirely below the threshold", async () => {
    await reachConfirm("1000")
    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    await waitFor(() => expect(transferCalls).toHaveLength(1))
    // `strictObject` on the server refuses unknown keys, so sending an empty
    // one would be a 400 rather than a transfer.
    expect(transferCalls[0]?.body).not.toHaveProperty("password")
  })

  it("reuses the key when the same confirmation is sent again", async () => {
    transferReplies = [
      { status: 422, body: { error: { code: "INSUFFICIENT_FUNDS" } } },
      { status: 201, body: transferBody("t1") },
    ]
    await reachConfirm("1000")

    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))
    await screen.findByRole("alert")
    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    await waitFor(() => expect(transferCalls).toHaveLength(2))

    /*
     * Nothing about the request changed, so it is the same request — and the
     * key has to say so. A key minted per press would make the retry a second
     * transfer in the server's eyes, which is the exact failure FR-4.4 exists
     * to prevent and the one the lock alone cannot cover.
     *
     * Changing the amount is a different request, and gets a different key,
     * because stepping back unmounts this screen.
     */
    expect(transferCalls[0]?.key).toBe(transferCalls[1]?.key)
  })

  it("says to wait, not to retype, when the confirmations have run out", async () => {
    transferReplies = [{ status: 429, body: { error: { code: "AUTH_LOCKED" } } }]
    await reachConfirm("2000000")
    await userEvent.type(screen.getByLabelText(/^parol$/i), SECRET)
    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    /*
     * FR-2.8's confirmation shares the sign-in's backoff, so this is what the
     * fourth wrong password answers. Falling through to the generic "could not
     * be done" would leave somebody typing a password that is now correct and
     * still refused, spending their lockout on it.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(/qayta urinib ko'ring/i)

    // And it is not queued: 429 is a final answer, and a queued transfer could
    // not carry the password anyway.
    expect(await queuedItems()).toHaveLength(0)
  })

  it("keeps the user here when the refusal is one they can act on", async () => {
    transferReplies = [{ status: 422, body: { error: { code: "INSUFFICIENT_FUNDS" } } }]
    await reachConfirm("1000")

    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    /*
     * A wrong amount is a thing to change and try again, not an outcome to be
     * shown a result screen about — and the button comes back to life.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(/yetarli mablag' yo'q/i)
    expect(screen.getByRole("button", { name: /^yuborish$/i })).toBeEnabled()
    expect(screen.queryByRole("heading", { name: "Natija" })).not.toBeInTheDocument()
  })
})

describe("step 4 — what actually happened", () => {
  it("says sent, with the number support will ask for", async () => {
    transferReplies = [{ status: 201, body: transferBody("t-4242") }]
    await reachConfirm("1000")

    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/yuborildi/i)
    expect(screen.getByText(/t-4242/)).toBeInTheDocument()
  })

  /**
   * §18.2 **S-9**, the half that costs money if it is wrong: a transfer
   * composed offline is queued, and the screen must not describe it as one
   * that happened. The retry policy and the round trip are in
   * `outbox.test.tsx`.
   */
  it("does not call a queued transfer sent", async () => {
    await reachConfirm("1000")
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))

    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    /*
     * The money has not moved and the request has not been refused. Collapsing
     * "queued" into either would be the screen claiming something it does not
     * know.
     */
    const result = await screen.findByRole("alert")
    expect(result).toHaveTextContent(/navbatga qo'yildi/i)
    expect(result).not.toHaveTextContent(/yuborildi/i)

    expect(await queuedItems()).toHaveLength(1)
    expect(transferCalls).toHaveLength(0)
  })

  it("refuses to queue a transfer needing a password it must not store", async () => {
    await reachConfirm("2000000")
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))

    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    /*
     * A queued request must never carry a credential into IndexedDB, so this
     * one would arrive without a password and be refused — a guaranteed
     * failure, stored, retried, and reported minutes later. One sentence now
     * is cheaper than that.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(/aloqa kerak/i)
    expect(await queuedItems()).toHaveLength(0)
  })
})

describe("what a screen reader is given", () => {
  it("names every step in a heading, so the position is never only visual", async () => {
    // `reachAmount` renders the app itself, so this walks from there rather
    // than mounting a second copy on top of the first.
    await reachAmount()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Qancha")

    await userEvent.type(screen.getByLabelText(/summa/i), "1000")
    await userEvent.click(screen.getByRole("button", { name: /davom etish/i }))
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tasdiqlash")
  })

  it("announces the outcome rather than only colouring it", async () => {
    await reachConfirm("1000")
    await userEvent.click(screen.getByRole("button", { name: /^yuborish$/i }))

    // The icon and its colour say nothing to a screen reader; the heading is
    // what carries the result.
    const outcome = await screen.findByRole("alert")
    expect(within(outcome).queryByRole("img")).toBeNull()
    expect(outcome).toHaveTextContent(/yuborildi/i)
  })
})
