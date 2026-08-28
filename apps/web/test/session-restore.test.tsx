import { render, waitFor } from "@testing-library/react"
import { Provider } from "react-redux"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { type AppStore, makeStore } from "../src/app/store.js"
import { resetSessionRestore, useSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { clearSessionHint, giveSessionHint } from "./renderApp.js"

/**
 * Boot, and the gap FR-2.4 creates.
 *
 * The access token is in memory, so a reload starts with none. Whether that
 * means "signed out" or "signed in, ask the cookie" is the question this hook
 * answers, and getting it wrong is invisible in a way that matters: the app
 * looks like it is working and quietly logs everyone out once a day.
 */

let calls: string[] = []
let script: () => Response | Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function Boot() {
  useSessionRestore()
  return null
}

function mount(store: AppStore) {
  return render(
    <Provider store={store}>
      <Boot />
    </Provider>,
  )
}

beforeEach(() => {
  calls = []
  resetRefreshState()
  resetSessionRestore()
  // These tests are about what happens *when the app asks*, so they all start
  // with the hint that makes it ask. The two that are about not asking clear
  // it themselves.
  giveSessionHint()
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    // Through `Request`, not `String(input)`: RTK Query passes a Request
    // object, and stringifying it yields "[object Request]" — which `new URL`
    // happily resolves to a path, so the mistake shows up as an empty filter
    // rather than as an error.
    calls.push(new URL(new Request(input, init).url).pathname)
    return Promise.resolve(script())
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessionHint()
})

describe("not asking when the answer is already known", () => {
  it("makes no request at all without the hint cookie", async () => {
    clearSessionHint()
    script = () => json(200, { accessToken: "restored", user: null })

    const store = makeStore()
    mount(store)

    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"))

    /*
     * The whole point. The refresh cookie is `httpOnly`, so before this the
     * only way to learn "nobody is signed in" was to ask and be refused —
     * a guaranteed 401 on the first paint of the login screen, a wasted round
     * trip on a bad connection, and a console error on every anonymous load.
     */
    expect(calls).toHaveLength(0)
  })

  it("still asks when the hint is there, even if the cookie turns out to be dead", async () => {
    script = () => json(401, {})

    const store = makeStore()
    mount(store)

    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"))
    // The hint is a hint, not an answer: a stale one costs exactly one request
    // and then behaves as it always did.
    expect(calls.filter((url) => url === "/api/auth/refresh")).toHaveLength(1)
  })
})

describe("restoring a session on boot", () => {
  it("asks the cookie exactly once", async () => {
    script = () => json(200, { accessToken: "restored", user: null })

    const store = makeStore()
    mount(store)

    await waitFor(() => expect(store.getState().auth.status).toBe("authenticated"))
    expect(calls.filter((url) => url === "/api/auth/refresh")).toHaveLength(1)
  })

  it("holds the restored token in memory", async () => {
    script = () => json(200, { accessToken: "restored", user: null })

    const store = makeStore()
    mount(store)

    await waitFor(() => expect(store.getState().auth.accessToken).toBe("restored"))
    expect(JSON.stringify(window.localStorage)).not.toContain("restored")
  })

  it("settles on anonymous when there is no cookie", async () => {
    script = () => json(401, {})

    const store = makeStore()
    mount(store)

    // Not an error state: arriving signed out is a normal way to arrive.
    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"))
  })

  it("settles on anonymous when the network is gone", async () => {
    // FR-8's world. A failed boot must still resolve, or the app sits on
    // "unknown" forever showing neither the login screen nor the wallet.
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")))

    const store = makeStore()
    mount(store)

    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"))
  })

  it("asks once when a second mount lands while the first is in flight", async () => {
    /*
     * The shape of the bug, taken from a browser rather than from a guess: two
     * `POST /auth/refresh` on one page load. Strict Mode is what produced it in
     * development, but the hazard is not Strict Mode — it is any second mount
     * arriving before the first request answers, which the status guard cannot
     * see because the status only changes when it does.
     *
     * Written with a held response rather than with `<StrictMode>`: React
     * remounts synchronously there, and RTK Query collapses two dispatches in
     * one tick into a single request, so a Strict Mode test passes whether or
     * not the guard exists. Verified by mutation — it did.
     *
     * The cost is not a wasted request. Refresh rotates the token (FR-2.6), so
     * the second call presents one the first has spent, §11.3's reuse detection
     * fires, and the family is revoked: the app signs itself out.
     */
    // Definite assignment: the executor runs synchronously, but TypeScript
    // cannot see that and narrows a `| null` binding to `never` at the call.
    let release!: () => void
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(json(200, { accessToken: "restored", user: null }))
    })
    script = () => held

    const store = makeStore()
    mount(store)
    // A tick, so the second mount is not collapsed into the first by RTK Query.
    await Promise.resolve()
    mount(store)

    release()
    await waitFor(() => expect(store.getState().auth.status).toBe("authenticated"))

    expect(calls.filter((url) => url === "/api/auth/refresh")).toHaveLength(1)
  })

  it("does not ask again once the answer is known", async () => {
    script = () => json(200, { accessToken: "restored", user: null })

    const store = makeStore()
    const { rerender } = mount(store)
    await waitFor(() => expect(store.getState().auth.status).toBe("authenticated"))

    rerender(
      <Provider store={store}>
        <Boot />
      </Provider>,
    )

    expect(calls.filter((url) => url === "/api/auth/refresh")).toHaveLength(1)
  })
})
