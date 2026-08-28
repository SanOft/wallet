import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"

/**
 * F3's home screen, and the rule the whole screen exists to hold: a number is
 * never shown without saying when it was true.
 *
 * The tests worth having here are not "does the balance render". They are the
 * ones about the gap between what the server last said and what is on the
 * glass — a tab left open on a dead network, a refetch that failed, a response
 * that did not match its contract. Every one of those renders a perfectly
 * plausible screen, which is what makes them dangerous.
 */

interface Reply {
  readonly status: number
  readonly body: unknown
}

const ACCOUNTS = {
  accounts: [{ id: "a1", currency: "UZS", balance: "125000000", type: "USER" }],
  user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
}

const HISTORY = {
  items: [
    {
      id: "t1",
      createdAt: "2026-08-28T09:00:00.000Z",
      status: "COMPLETED",
      type: "P2P",
      channel: "WEB",
      direction: "outgoing",
      amount: "500000",
      counterparty: { maskedName: "ZULFIYA K." },
    },
    {
      id: "t2",
      createdAt: "2026-08-28T08:00:00.000Z",
      status: "COMPLETED",
      type: "TOPUP",
      channel: "WEB",
      direction: "incoming",
      amount: "100000000",
      counterparty: null,
    },
  ],
  nextCursor: null,
}

const RATES = {
  rates: [
    { currency: "USD", rate: "11801.23", diff: "-22.46", nominal: "1", publishedOn: "2026-08-28" },
    { currency: "EUR", rate: "13737.81", diff: "-59.25", nominal: "1", publishedOn: "2026-08-28" },
  ],
  fetchedAt: "2026-08-28T10:00:00.000Z",
  stale: false,
}

const OK: Record<string, Reply> = {
  "/api/auth/refresh": { status: 200, body: { accessToken: "session", user: null } },
  "/api/accounts": { status: 200, body: ACCOUNTS },
  "/api/transfers": { status: 200, body: HISTORY },
  "/api/rates": { status: 200, body: RATES },
}

/** Every request the page makes, in order, so a test can assert on headers. */
let calls: Array<{ url: string; headers: Headers }>
let script: (url: string, call: number) => Reply | "network-failure"

beforeEach(() => {
  resetRefreshState()
  resetSessionRestore()
  calls = []
  script = (url) => OK[url] ?? { status: 200, body: {} }
  window.history.pushState({}, "", "/")

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url).pathname
    const seen = calls.filter((call) => call.url === url).length
    calls.push({ url, headers: request.headers })

    const answer = script(url, seen)
    if (answer === "network-failure") return Promise.reject(new TypeError("Failed to fetch"))

    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      }),
    )
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // `navigator.onLine` is spied on in one test, and without this every test
  // after it runs offline — which changes what the freshness line says and
  // makes unrelated assertions fail somewhere else in the file.
  vi.restoreAllMocks()
})

async function showHome() {
  render(<App />)
  return screen.findByRole("heading", { name: "Wallet", level: 1 })
}

function balanceCard() {
  return screen.getByRole("region", { name: "Hisobingiz" })
}

describe("the balance, and when it was true (FR-3, FR-3.4)", () => {
  it("shows the amount with the age of the figure", async () => {
    await showHome()

    const card = balanceCard()
    await waitFor(() => expect(card).toHaveTextContent(/1 250 000/))
    // The age is not optional decoration: it is the difference between "your
    // balance is" and "your balance was".
    expect(card).toHaveTextContent(/yangilangan/)
  })

  it("refuses to show a balance it does not have, rather than showing zero", async () => {
    script = (url) =>
      url === "/api/accounts" ? "network-failure" : (OK[url] ?? { status: 200, body: {} })
    await showHome()

    const card = await screen.findByRole("region", { name: "Hisobingiz" })
    await waitFor(() => expect(within(card).getByRole("alert")).toBeInTheDocument())

    // A zero balance and an unknown balance are the same shape on screen and
    // opposite facts. The wrong one makes somebody top up money they have.
    expect(card).not.toHaveTextContent(/^0 so'm$/)
    expect(card).toHaveTextContent(/imkoni bo'lmadi/)
  })

  it("keeps the last figure but stops calling it current when a refetch fails", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    // The reconnect listener refetches; this time the network is gone. The old
    // number stays on screen — throwing it away would be worse — but it stops
    // being presented in the present tense.
    script = (url) =>
      url === "/api/accounts" ? "network-failure" : (OK[url] ?? { status: 200, body: {} })
    const before = calls.filter((call) => call.url === "/api/accounts").length
    act(() => {
      window.dispatchEvent(new Event("online"))
    })

    // Asserted before the text: if the reconnect never triggers a refetch, the
    // failure should say so rather than pointing at the sentence that was
    // never going to change.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/accounts").length).toBeGreaterThan(before),
    )
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/ulanib bo'lmadi/))
    expect(balanceCard()).toHaveTextContent(/1 250 000/)
  })

  it("says the connection is gone without waiting for a request to fail", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      window.dispatchEvent(new Event("offline"))
    })

    // Waiting for a timeout first would leave the screen claiming currency for
    // as long as the timeout lasts.
    const banner = await screen.findByText(/Aloqa yo'q\./)
    expect(banner).toBeInTheDocument()

    // The condition is stated once, by the banner. The card carries the part
    // that differs per figure — how old this number is — and the number
    // itself stays, because removing it would be worse than dating it.
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/gi ma'lumot/))
    expect(balanceCard()).toHaveTextContent(/1 250 000/)
    expect(within(balanceCard()).queryByText(/Aloqa yo'q/)).toBeNull()
  })

  it("names the server when the device thinks it is online", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    script = (url) =>
      url === "/api/accounts" ? "network-failure" : (OK[url] ?? { status: 200, body: {} })
    act(() => {
      window.dispatchEvent(new Event("online"))
    })

    // No banner for this one — the device believes it has a connection — so
    // the card is the only place the user is told anything at all.
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/ulanib bo'lmadi/))
    expect(screen.queryByText(/Aloqa yo'q\./)).toBeNull()
  })

  it("takes the banner down when the connection returns", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      window.dispatchEvent(new Event("offline"))
    })
    await screen.findByText(/Aloqa yo'q\./)

    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
      window.dispatchEvent(new Event("online"))
    })

    // A warning that outlives its condition is a warning people learn to
    // dismiss without reading.
    await waitFor(() => expect(screen.queryByText(/Aloqa yo'q\./)).toBeNull())
  })
})

describe("a response that does not match its contract", () => {
  it("is treated as a failure rather than rendered", async () => {
    // What a proxy's error page, or an origin serving index.html for /api,
    // looks like: a 200 with a body nothing on this screen can use.
    script = (url) =>
      url === "/api/accounts"
        ? { status: 200, body: { balance: "125000000" } }
        : (OK[url] ?? { status: 200, body: {} })

    await showHome()

    const card = await screen.findByRole("region", { name: "Hisobingiz" })
    await waitFor(() => expect(within(card).getByRole("alert")).toBeInTheDocument())
  })
})

describe("the demo top-up (FR-10, S-6)", () => {
  it("carries a fresh idempotency key on every attempt", async () => {
    await showHome()
    const button = await screen.findByRole("button", { name: /demo to'ldirish/i })

    await userEvent.click(button)
    await waitFor(() => expect(calls.some((call) => call.url === "/api/accounts/topup")).toBe(true))
    await userEvent.click(await screen.findByRole("button", { name: /demo to'ldirish/i }))
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/accounts/topup")).toHaveLength(2),
    )

    const keys = calls
      .filter((call) => call.url === "/api/accounts/topup")
      .map((call) => call.headers.get("idempotency-key"))

    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    for (const key of keys) expect(key).toMatch(V4)
    // A reused key past its retention is a 409 the user cannot act on, so the
    // second attempt must not be the first one again.
    expect(new Set(keys).size).toBe(2)
  })

  it("refetches the balance and the history together", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))
    const before = calls.filter((call) => call.url === "/api/transfers").length

    await userEvent.click(await screen.findByRole("button", { name: /demo to'ldirish/i }))

    // New money above a list that does not mention where it came from is the
    // screen telling the user two different things.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/transfers").length).toBeGreaterThan(before),
    )
    expect(calls.filter((call) => call.url === "/api/accounts").length).toBeGreaterThan(1)
  })

  it("says what a spent daily allowance means, not just that it failed", async () => {
    script = (url) =>
      url === "/api/accounts/topup"
        ? { status: 422, body: { error: { code: "LIMIT_EXCEEDED", requestId: "r" } } }
        : (OK[url] ?? { status: 200, body: {} })

    await showHome()
    await userEvent.click(await screen.findByRole("button", { name: /demo to'ldirish/i }))

    // "Try again" is wrong advice for a limit that resets tomorrow.
    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/ertaga/i)
  })
})

describe("the recent transactions (§13.3)", () => {
  it("names the counterparty, the direction and the sign", async () => {
    await showHome()

    const outgoing = await screen.findByText("ZULFIYA K.")
    const row = outgoing.closest("li")
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent(/5 000 so'm/)
    // The direction is spoken, not only drawn: an arrow and a colour say
    // nothing to a screen reader, and the same row read aloud must still say
    // which way the money went.
    expect(row).toHaveTextContent(/chiqim/)
  })

  it("calls a top-up what the user did, not what the ledger did", async () => {
    await showHome()

    // The other side of a top-up is the treasury; naming it would be
    // describing plumbing to someone asking where their money came from.
    const row = (await screen.findByText("Demo to'ldirish")).closest("li")
    expect(row).toHaveTextContent(/kirim/)
    expect(row).toHaveTextContent(/1 000 000 so'm/)
  })

  it("suggests a first step when there is genuinely nothing", async () => {
    script = (url) =>
      url === "/api/transfers"
        ? { status: 200, body: { items: [], nextCursor: null } }
        : (OK[url] ?? { status: 200, body: {} })

    await showHome()

    expect(await screen.findByText(/hali amaliyot yo'q/i)).toBeInTheDocument()
  })

  it("distinguishes an empty history from one it could not load", async () => {
    script = (url) =>
      url === "/api/transfers" ? "network-failure" : (OK[url] ?? { status: 200, body: {} })

    await showHome()

    // Both are a blank space, and they mean opposite things. The wrong one
    // tells somebody their transfer never happened.
    expect(await screen.findByText(/amaliyotlarni olishning imkoni bo'lmadi/i)).toBeInTheDocument()
    expect(screen.queryByText(/hali amaliyot yo'q/i)).not.toBeInTheDocument()
  })
})

describe("the rates widget (FR-7)", () => {
  it("shows the values and where they came from", async () => {
    await showHome()

    const rates = await screen.findByRole("region", { name: /valyuta kurslari/i })
    expect(rates).toHaveTextContent("11801.23")
    expect(rates).toHaveTextContent(/2026-08-28/)
  })

  it("repeats the server's own verdict on staleness rather than forming its own", async () => {
    script = (url) =>
      url === "/api/rates"
        ? { status: 200, body: { ...RATES, stale: true } }
        : (OK[url] ?? { status: 200, body: {} })

    await showHome()

    const rates = await screen.findByRole("region", { name: /valyuta kurslari/i })
    await waitFor(() => expect(rates).toHaveTextContent(/aloqa yo'q/i))
  })

  it("disappears when it cannot be had, rather than shouting", async () => {
    script = (url) =>
      url === "/api/rates" ? "network-failure" : (OK[url] ?? { status: 200, body: {} })

    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    // FR-7.3 makes these numbers informational. An error message for
    // decoration teaches people to ignore error messages.
    expect(screen.queryByRole("region", { name: /valyuta kurslari/i })).not.toBeInTheDocument()
  })
})

describe("what a screen reader is given", () => {
  it("has no accessibility violations axe can detect without layout", async () => {
    const { container } = render(<App />)
    await screen.findByRole("heading", { name: "Wallet", level: 1 })
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    const results = await axe.run(container, {
      resultTypes: ["violations"],
      // No layout engine in jsdom, so these two would report on a page that
      // has no geometry. Contrast is computed from the stylesheet in
      // `contrast.test.ts`; touch size is asserted in `shell.test.tsx`.
      rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
    })

    expect(results.violations.map((violation) => violation.id)).toEqual([])
  })

  it("does not announce the ticking age, which would make the page unusable", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/yangilangan/))

    // Scoped to the card: the transactions list carries its own freshness
    // line, so an unscoped query matches both and says only that the page has
    // two of them.
    const age = within(balanceCard()).getByText(/yangilangan/)
    const live = age.closest("[aria-live], [role='status'], [role='alert']")

    // This text rewrites itself every fifteen seconds. In a live region that
    // is "two minutes ago" read aloud four times a minute, over whatever the
    // user was actually doing — the one change that would make this app worse
    // for the people the freshness line is meant to serve.
    expect(live).toBeNull()
  })

  it("announces the loss of connection once, without interrupting", async () => {
    await showHome()
    await waitFor(() => expect(balanceCard()).toHaveTextContent(/1 250 000/))

    act(() => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      window.dispatchEvent(new Event("offline"))
    })

    const warning = await screen.findByText(/Aloqa yo'q\./)
    // `status`, not `alert`: worth saying at the next pause, not worth cutting
    // across the sentence someone is in the middle of hearing — least of all
    // when the person cannot easily find their place again.
    expect(warning.closest("[role='status']")).not.toBeNull()
    expect(warning.closest("[role='alert']")).toBeNull()
  })
})
