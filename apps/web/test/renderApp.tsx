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

export function stubSession(options: { readonly signedIn: boolean }) {
  resetRefreshState()
  resetSessionRestore()

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

    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )
  })
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
