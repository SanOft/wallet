import { render, waitFor } from "@testing-library/react"
import { vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"

/**
 * Renders the shell with a session, by answering the boot refresh.
 *
 * `App` owns its store, so a test cannot hand it a signed-in state directly.
 * That is deliberate rather than an oversight: the way a real session begins is
 * the cookie exchange in §11.3, and a test that skipped it would assert against
 * a state the application can only reach by being told to.
 *
 * The cost is that these tests are asynchronous. It buys the boot path being
 * exercised by every shell test rather than only by its own.
 */

/**
 * The readable companion the boot refresh now checks before asking.
 *
 * Without it the application does not call `/api/auth/refresh` at all — which
 * is the point of the cookie — so a test that stubs a successful refresh and
 * forgets this one is testing a request nobody makes.
 */
export function giveSessionHint(): void {
  /*
   * The rule prefers `CookieStore`, which jsdom does not implement — and
   * `document.cookie` is the API the code under test reads, so writing through
   * a different one would test nothing. The suppression has to be the *last*
   * comment line before the statement, which is why the reasoning sits above
   * it rather than inside it.
   */
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no CookieStore
  document.cookie = "wallet_session=1; path=/"
}

export function clearSessionHint(): void {
  // biome-ignore lint/suspicious/noDocumentCookie: see giveSessionHint
  document.cookie = "wallet_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
}

export function stubSession(options: { readonly signedIn: boolean }) {
  resetRefreshState()
  resetSessionRestore()

  // A signed-out visitor has no hint, and the app must not ask on their
  // behalf; a signed-in one does, which is what makes the stubbed refresh
  // reachable at all.
  if (options.signedIn) giveSessionHint()
  else clearSessionHint()

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url).pathname

    if (url === "/api/auth/refresh") {
      return Promise.resolve(
        options.signedIn
          ? new Response(JSON.stringify({ accessToken: "session", user: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
      )
    }

    /*
     * Contract-shaped, not `{}`.
     *
     * The shell tests used to answer every other call with an empty object,
     * which the client now rejects as not matching the contract — correctly,
     * since an empty object is what a proxy's error page looks like. Answering
     * with the real shape keeps these tests about the shell rather than about
     * the failure state of every widget inside it.
     */
    const body = FIXTURES[url] ?? {}
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })
}

/** The smallest response each home-screen endpoint will accept. */
const FIXTURES: Readonly<Record<string, unknown>> = {
  "/api/accounts": {
    accounts: [{ id: "a1", currency: "UZS", balance: "100000000", type: "USER" }],
    user: { id: "u1", phone: "+998901234567", firstName: "Alisher", lastName: "Navoiy" },
    limits: {
      perOperation: "1000000000",
      daily: { limit: "3000000000", spent: "0", remaining: "3000000000" },
    },
  },
  "/api/transfers": { items: [], nextCursor: null },
  "/api/rates": {
    rates: [
      {
        currency: "USD",
        rate: "11801.23",
        diff: "-22.46",
        nominal: "1",
        publishedOn: "2026-08-28",
      },
    ],
    fetchedAt: "2026-08-28T10:00:00.000Z",
    stale: false,
  },
}

/** Renders and waits until the session question has been answered. */
export async function renderSignedIn() {
  stubSession({ signedIn: true })
  const result = render(<App />)
  await waitFor(() => {
    if (!result.container.querySelector("nav")) throw new Error("not signed in yet")
  })
  return result
}

export async function renderSignedOut() {
  stubSession({ signedIn: false })
  const result = render(<App />)
  await waitFor(() => {
    if (!result.container.querySelector("form")) throw new Error("login screen not shown yet")
  })
  return result
}
