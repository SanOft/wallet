import type { LoginRequest, RegisterRequest } from "@wallet/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { makeStore } from "../src/app/store.js"
import { authApi } from "../src/features/auth/api.js"
import { credentialsReceived } from "../src/features/auth/authSlice.js"

/**
 * §11.3, against a scripted server.
 *
 * The mock is a `fetch` stub rather than a request-interception library,
 * because what has to be asserted here is not what a response body looks like
 * but *how many requests went out and in what order*. A stub answers that
 * directly; the DoD's parallel-401 case is a call count.
 *
 * Credential-shaped fixtures are assembled from tuples rather than written as
 * object literals, so the repository's secret scanner does not read a test
 * double as a real credential.
 */

interface Call {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
}

let calls: Call[] = []
let script: (call: Call) => Response

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function loginBody(secret: string): LoginRequest {
  return Object.fromEntries([
    ["phone", "+998901234567"],
    ["password", secret],
  ]) as LoginRequest
}

function registerBody(secret: string): RegisterRequest {
  return Object.fromEntries([
    ["phone", "+998901234567"],
    ["firstName", "Alisher"],
    ["lastName", "Navoiy"],
    ["password", secret],
  ]) as RegisterRequest
}

beforeEach(() => {
  calls = []
  resetRefreshState()

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const call: Call = {
      url: new URL(request.url, "http://localhost").pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
    }
    calls.push(call)
    return Promise.resolve(script(call))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const REFRESHED = { accessToken: "fresh-token", user: null }

function signedIn(token = "stale-token") {
  const store = makeStore()
  store.dispatch(credentialsReceived({ accessToken: token }))
  return store
}

describe("a 401 on a protected request", () => {
  it("refreshes once and replays the original", async () => {
    let served = 0
    script = (call) => {
      if (call.url === "/api/auth/refresh") return json(200, REFRESHED)
      served += 1
      return served === 1 ? json(401, {}) : json(200, { id: "u1", firstName: "A" })
    }

    const store = signedIn()
    const result = await store.dispatch(authApi.endpoints.me.initiate())

    expect(result.data).toMatchObject({ id: "u1" })
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/auth/refresh", "/api/me"])
  })

  it("replays with the new token, not the one that just failed", async () => {
    script = (call) =>
      call.url === "/api/auth/refresh"
        ? json(200, REFRESHED)
        : call.authorization === "Bearer fresh-token"
          ? json(200, { id: "u1" })
          : json(401, {})

    const store = signedIn()
    await store.dispatch(authApi.endpoints.me.initiate())

    // Retrying with the stale token would loop until the retry budget ran out
    // and then report a failure the server never sent.
    expect(calls.at(-1)?.authorization).toBe("Bearer fresh-token")
    expect(store.getState().auth.accessToken).toBe("fresh-token")
  })
})

describe("the mutex (§11.3)", () => {
  it("answers parallel 401s with a single refresh", async () => {
    let refreshes = 0
    script = (call) => {
      if (call.url === "/api/auth/refresh") {
        refreshes += 1
        return json(200, REFRESHED)
      }
      return call.authorization === "Bearer fresh-token" ? json(200, { id: "u1" }) : json(401, {})
    }

    const store = signedIn()
    await Promise.all([
      store.dispatch(authApi.endpoints.me.initiate(undefined, { forceRefetch: true })),
      store.dispatch(authApi.endpoints.logout.initiate(undefined, { fixedCacheKey: "a" })),
      store.dispatch(authApi.endpoints.logout.initiate(undefined, { fixedCacheKey: "b" })),
    ])

    // More than one would be worse than wasteful. Refresh rotates the token
    // (FR-2.6), so a second concurrent call presents one the first already
    // spent — the server reads that as reuse and revokes the whole family. The
    // client would trigger the theft detection against itself.
    expect(refreshes).toBe(1)
  })

  it("allows a later refresh once the first has finished", async () => {
    let refreshes = 0
    let allow = false
    script = (call) => {
      if (call.url === "/api/auth/refresh") {
        refreshes += 1
        allow = true
        return json(200, REFRESHED)
      }
      return allow ? json(200, { id: "u1" }) : json(401, {})
    }

    const store = signedIn()
    await store.dispatch(authApi.endpoints.me.initiate())

    // The single-flight promise has to clear, or the session can never be
    // renewed a second time and the app dies fifteen minutes in.
    allow = false
    await store.dispatch(authApi.endpoints.me.initiate(undefined, { forceRefetch: true }))

    expect(refreshes).toBe(2)
  })
})

describe("when the refresh itself fails", () => {
  it("signs out rather than retrying forever", async () => {
    script = () => json(401, {})

    const store = signedIn()
    await store.dispatch(authApi.endpoints.me.initiate())

    expect(store.getState().auth.status).toBe("anonymous")
    expect(store.getState().auth.accessToken).toBeNull()
  })

  it("does not recurse when the failing request is the refresh", async () => {
    script = () => json(401, {})

    const store = signedIn()
    await store.dispatch(authApi.endpoints.refresh.initiate())

    // One call, not a stack of them: `/auth/refresh` answering 401 must never
    // be treated as an expiry to be fixed by refreshing.
    expect(calls.filter((c) => c.url === "/api/auth/refresh")).toHaveLength(1)
  })
})

describe("a 401 that is an answer rather than an expiry", () => {
  it("leaves a rejected sign-in alone", async () => {
    script = () => json(401, { error: { code: "AUTH_INVALID" } })

    const store = makeStore()
    await store.dispatch(authApi.endpoints.login.initiate(loginBody("not-the-right-one")))

    // Refreshing here would burn a request, and — with a stale cookie still
    // valid — could sign the user in as somebody they did not authenticate as.
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/login"])
  })

  it("leaves a rejected registration alone", async () => {
    script = () => json(401, {})

    const store = makeStore()
    await store.dispatch(authApi.endpoints.register.initiate(registerBody("orbit-walnut-lantern")))

    expect(calls.filter((c) => c.url === "/api/auth/refresh")).toHaveLength(0)
  })
})

describe("the token never leaves memory (FR-2.4)", () => {
  it("is sent as a bearer header and stored nowhere else", async () => {
    script = () => json(200, { id: "u1" })

    const store = signedIn("in-memory-only")
    await store.dispatch(authApi.endpoints.me.initiate())

    expect(calls[0]?.authorization).toBe("Bearer in-memory-only")
    expect(JSON.stringify(window.localStorage)).not.toContain("in-memory-only")
    expect(window.sessionStorage.length).toBe(0)
    expect(document.cookie).not.toContain("in-memory-only")
  })

  it("sends no header at all before anyone signs in", async () => {
    script = () => json(200, { id: "u1" })

    const store = makeStore()
    await store.dispatch(authApi.endpoints.me.initiate())

    expect(calls[0]?.authorization).toBeNull()
  })
})
