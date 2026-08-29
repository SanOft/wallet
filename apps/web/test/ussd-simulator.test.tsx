import "fake-indexeddb/auto"

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { USSD_SESSION_TTL_MS } from "@wallet/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { clearOutbox, queuedItems } from "../src/lib/outbox.js"
import { clearReadCache, resetReadCacheConnection } from "../src/lib/readCache.js"
import { giveSessionHint } from "./renderApp.js"

/**
 * F7's simulator (FR-9.6), and I5's criterion: the §11.7 session, end to end.
 *
 * The assertions that matter are about the wire rather than about the layout.
 * A simulator whose screen looks right while its requests are wrong is worse
 * than no simulator, because the thing it exists to demonstrate is precisely
 * the request.
 */

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "500000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
}

/** The adapter's real replies, so the test fails if their shape changes. */
const MENU = "CON Wallet\n1. Balans\n2. Pul o'tkazish\n3. Tarix"

interface Dialled {
  readonly text: string
  readonly sessionId: string
  readonly phoneNumber: string
}

let dialled: Dialled[]
/** Answers, in order. A `null` entry makes the request fail in transport. */
let replies: Array<string | null>

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
  window.history.pushState({}, "", "/labs/ussd")

  dialled = []
  replies = []

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(input instanceof URL ? input.href : input, location.href), init)
    const url = new URL(request.url)

    if (url.pathname === "/api/channels/ussd/simulate") {
      const body = (await request.clone().json()) as Dialled
      dialled.push(body)

      const reply = replies.shift()
      if (reply === undefined) throw new Error(`no reply queued for text="${body.text}"`)
      if (reply === null) throw new TypeError("Failed to fetch")

      return new Response(reply, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    if (url.pathname === "/api/auth/refresh") return json({ accessToken: "s", user: null })
    if (url.pathname === "/api/accounts") return json(ACCOUNTS)
    if (url.pathname === "/api/transfers") return json({ items: [], nextCursor: null })
    if (url.pathname === "/api/rates") {
      return json({ rates: [], fetchedAt: "2026-08-28T10:00:00.000Z", stale: false })
    }
    return json({})
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * `delay: null`, which is why this file is not the slowest in the suite.
 *
 * By default `userEvent` awaits between keystrokes, so typing a nine-digit
 * recipient number is nine scheduler turns plus nine React renders. The full
 * §11.7 session does that across five round trips and measured 5152 ms against
 * a 5000 ms default — passing alone, timing out inside `yarn verify`, where the
 * API suite has just run and coverage instrumentation is attached.
 *
 * It is a real cost, not a race: nothing is waiting on a signal it might miss.
 * Removing the inter-key delay changes no behaviour this file asserts — the
 * per-keystroke handling belongs to `form-fields.test.tsx`, and what these
 * tests are about is the wire.
 */
function typist() {
  return userEvent.setup({ delay: null })
}

async function openLab() {
  render(<App />)
  return screen.findByRole("heading", { name: "USSD simulyatori", level: 1 })
}

/** Dials the shortcode and waits for the first screen. */
async function dial(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /terish/i }))
  return screen.findByText(/1\. Balans/)
}

async function type(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.type(screen.getByLabelText(/javobingiz|PIN kod/i), value)
  await user.click(screen.getByRole("button", { name: /^yuborish$/i }))
}

describe("the §11.7 session, end to end (I5)", () => {
  it("walks the whole transfer and accumulates text on every step", async () => {
    replies = [
      MENU,
      "CON Qabul qiluvchi raqamini kiriting",
      "CON ZULFIYA K.\nSumma (so'm)",
      "CON 50 000 so'm\nTasdiqlash uchun PIN kodni kiriting",
      "END 50 000 so'm yuborildi.\nBalans: 950 000 so'm",
    ]

    const user = typist()
    await openLab()
    await dial(user)

    await type(user, "2")
    await screen.findByText(/Qabul qiluvchi/)

    await type(user, "901234567")
    await screen.findByText(/ZULFIYA K\./)

    await type(user, "50000")
    await screen.findByText(/Tasdiqlash uchun PIN/)

    await type(user, "1234")
    await screen.findByText(/yuborildi/)

    /*
     * The whole point of FR-9.2, asserted rather than assumed: every request
     * carries the entire conversation, and the opening dial carries an empty
     * string rather than being skipped.
     */
    expect(dialled.map((call) => call.text)).toEqual([
      "",
      "2",
      "2*901234567",
      "2*901234567*50000",
      "2*901234567*50000*1234",
    ])
    /*
     * Twenty seconds, declared rather than inherited.
     *
     * This is the longest test in the repository and it earns it: five full
     * request/response cycles through RTK Query, each re-rendering the tree and
     * each awaited by `findByText`. It measured 5152 ms against the 5000 ms
     * default — green on its own, timing out inside `yarn verify`, where the
     * API suite has just run and coverage instrumentation is attached.
     *
     * Nothing here waits on a signal it might miss, so the bound is not hiding
     * a race; the work is real and the default is simply too tight for it.
     * `delay: null` on the typing was tried first and did not move it, which is
     * what identified the round trips rather than the keystrokes as the cost.
     */
  }, 20_000)

  it("keeps one session id for the whole conversation", async () => {
    replies = [MENU, "CON Qabul qiluvchi raqamini kiriting"]

    const user = typist()
    await openLab()
    await dial(user)
    await type(user, "2")
    await screen.findByText(/Qabul qiluvchi/)

    /*
     * The adapter derives its idempotency key from the session id and the
     * text. A new id per step would make every step a new session — and the
     * redelivery protection, which is what stops a repeated final step sending
     * money twice, would never match anything.
     */
    const ids = new Set(dialled.map((call) => call.sessionId))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("closes the session on END and offers a fresh dial", async () => {
    replies = [MENU, "END Balans: 1 000 000 so'm"]

    const user = typist()
    await openLab()
    await dial(user)
    await type(user, "1")
    await screen.findByText(/Balans: 1 000 000/)

    // No input, because there is nothing the network would accept: the session
    // is over. Leaving the field there invites typing into a session that
    // cannot receive it.
    expect(screen.queryByLabelText(/javobingiz/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /qaytadan terish/i })).toBeInTheDocument()
  })
})

describe("what it refuses to show as a reply", () => {
  it("names a transport failure as the gateway, not as an answer", async () => {
    replies = [null]

    const user = typist()
    await openLab()
    await user.click(screen.getByRole("button", { name: /terish/i }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/shlyuz/i)

    /*
     * A failed request must never leave a screen behind that looks like
     * something the server said. On the final step of a transfer that screen
     * would be a confirmation for money that never moved.
     */
    expect(screen.queryByText(/1\. Balans/)).not.toBeInTheDocument()
  })

  it("refuses to render a body that is not a USSD reply", async () => {
    // The realistic case: an origin answering /api with the SPA's index.html.
    replies = ["<!doctype html><title>Wallet</title>"]

    const user = typist()
    await openLab()
    await user.click(screen.getByRole("button", { name: /terish/i }))

    expect(await screen.findByText(/USSD formatida emas/i)).toBeInTheDocument()
    expect(screen.queryByText(/doctype/i)).not.toBeInTheDocument()
  })

  it("offers the failed step again on the same session, not a new one", async () => {
    replies = [null, MENU]

    const user = typist()
    await openLab()
    await user.click(screen.getByRole("button", { name: /terish/i }))
    await screen.findByRole("alert")

    await user.click(screen.getByRole("button", { name: /qayta yuborish/i }))
    await screen.findByText(/1\. Balans/)

    /*
     * Same id, same text. That is what makes the retry safe: the adapter keys
     * on both, so a step that did reach the server returns its stored answer
     * instead of being executed a second time.
     */
    expect(dialled).toHaveLength(2)
    expect(dialled[0]?.sessionId).toBe(dialled[1]?.sessionId)
    expect(dialled[1]?.text).toBe("")
  })
})

describe("offline", () => {
  it("refuses to dial and never queues it", async () => {
    replies = [MENU]

    const user = typist()
    await openLab()
    await dial(user)

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    window.dispatchEvent(new Event("offline"))

    await screen.findByText(/navbatga qo'yilmaydi/i)
    expect(screen.getByRole("button", { name: /^yuborish$/i })).toBeDisabled()

    /*
     * The outbox is the app's answer to a failed write, and it is the wrong
     * answer here. A dial replayed when the connection returns would be sent
     * into a session the network dropped minutes ago — and on the last step it
     * would carry a transfer.
     */
    expect(await queuedItems()).toEqual([])
  })
})

describe("the 180-second session (FR-9.4)", () => {
  it("never claims more time than the network gives", async () => {
    /*
     * It opened at 185 in a browser. `now` is written by a one-second
     * interval, so the first render after a reply was measuring against a
     * clock up to a second behind the reply itself — and the page advertised
     * five seconds the network had no intention of honouring.
     */
    replies = [MENU]
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime.bind(vi) })
    await openLab()

    /*
     * The gap is the test. Mounting and dialling in the same millisecond hides
     * the bug entirely — in a browser five seconds passed between the page
     * loading and the button being pressed, and the countdown opened at 185.
     */
    await vi.advanceTimersByTimeAsync(5000)
    await dial(user)

    const shown = await screen.findByRole("timer")
    expect(Number(shown.textContent)).toBeLessThanOrEqual(USSD_SESSION_TTL_MS / 1000)
    expect(Number(shown.textContent)).toBeGreaterThan(0)
  })

  it("ends by itself, and says the network did it", async () => {
    replies = [MENU]
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime.bind(vi) })
    await openLab()
    await dial(user)

    expect(screen.getByLabelText(/javobingiz/i)).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(USSD_SESSION_TTL_MS + 1000)

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/180 soniya harakatsiz/i)
    })
    // The field goes with the session. Typing into an expired one would be
    // typing into nothing.
    expect(screen.queryByLabelText(/javobingiz/i)).not.toBeInTheDocument()
  })
})

describe("the wire panel", () => {
  it("hides the PIN until asked, and shows the rest", async () => {
    replies = [
      MENU,
      "CON Qabul qiluvchi raqamini kiriting",
      "CON ZULFIYA K.\nSumma (so'm)",
      "CON 50 000 so'm\nTasdiqlash uchun PIN kodni kiriting",
      "END 50 000 so'm yuborildi.",
    ]

    const user = typist()
    await openLab()
    await dial(user)
    await type(user, "2")
    await screen.findByText(/Qabul qiluvchi/)
    await type(user, "901234567")
    await screen.findByText(/ZULFIYA K\./)
    await type(user, "50000")
    await screen.findByText(/Tasdiqlash uchun PIN/)
    await type(user, "1234")
    await screen.findByText(/yuborildi/)

    expect(screen.getByText("2*901234567*50000*****")).toBeInTheDocument()
    expect(screen.queryByText("2*901234567*50000*1234")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /PIN kodni ko'rsatish/i }))
    expect(screen.getByText("2*901234567*50000*1234")).toBeInTheDocument()
  })

  it("masks the PIN field while it is being typed", async () => {
    replies = [MENU, "CON PIN kodni kiriting"]

    const user = typist()
    await openLab()
    await dial(user)
    await type(user, "1")
    await screen.findByText(/PIN kodni kiriting/)

    expect(screen.getByLabelText(/PIN kod/i)).toHaveAttribute("type", "password")
  })
})

describe("the septet budget", () => {
  it("measures the reply with the function the adapter fits it with", async () => {
    replies = [MENU]

    const user = typist()
    await openLab()
    await dial(user)

    /*
     * 42, and the literal is the point: asserting `gsm7Septets(MENU)` here
     * would only prove the screen agrees with itself. The menu is 42
     * characters after the `CON ` prefix, every one of them in the basic
     * alphabet, so it costs one septet each.
     */
    expect(screen.getByText("42/182 septet")).toBeInTheDocument()
  })

  it("says so when a reply could not travel as GSM-7 at all", async () => {
    // A Cyrillic name that escaped `toGsm7` would collapse the budget from 182
    // to 70 and be cut by the network with nothing logged.
    replies = ["END Зулфия"]

    const user = typist()
    await openLab()
    await user.click(screen.getByRole("button", { name: /terish/i }))

    expect(await screen.findByText(/GSM-7 emas/i)).toBeInTheDocument()
  })
})
