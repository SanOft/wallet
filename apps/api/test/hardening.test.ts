import { randomUUID } from "node:crypto"
import { apiErrorSchema } from "@wallet/shared"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { buildApp, PRISMA_STUB } from "./helpers.js"

/**
 * §17.3's checklist, as tests. Each item there is a control someone can claim
 * is "configured"; these are what make the claim checkable.
 */

const ORIGIN = "https://wallet.example.com"

function app(env: NodeJS.ProcessEnv = {}) {
  return buildApp(PRISMA_STUB, { ...env }).app
}

describe("security headers (§17.1, §17.3)", () => {
  it("sets a content security policy that permits nothing", async () => {
    const res = await request(app()).get("/health")

    const csp = res.headers["content-security-policy"] ?? ""
    // An API returns JSON and never a document, so there is nothing legitimate
    // for a browser to load from this origin.
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
  })

  it("tells the browser never to try plaintext again", async () => {
    const res = await request(app()).get("/health")

    // Matters because the refresh cookie is marked Secure in production: a
    // single plaintext attempt is a single chance to strip it.
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000")
    expect(res.headers["strict-transport-security"]).toContain("includeSubDomains")
  })

  it("refuses to be framed and names no referrer", async () => {
    const res = await request(app()).get("/health")

    expect(res.headers["x-frame-options"]?.toLowerCase()).toBe("deny")
    expect(res.headers["referrer-policy"]).toBe("no-referrer")
  })

  it("does not advertise the framework", async () => {
    const res = await request(app()).get("/health")
    expect(res.headers["x-powered-by"]).toBeUndefined()
  })

  it("puts the headers on an error response too", async () => {
    // The path that matters most: a 404 or a 500 is still a response a browser
    // may render, and a policy that only covers the happy path is not a policy.
    const res = await request(app()).get("/api/does-not-exist")

    expect(res.status).toBe(404)
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'")
  })
})

describe("CORS is an allowlist, never a wildcard (NFR-1.8)", () => {
  it("echoes an allowed origin and permits credentials", async () => {
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .get("/health")
      .set("origin", ORIGIN)

    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN)
    // Required for the refresh cookie; a wildcard is forbidden by the browser
    // in this mode anyway, so the allowlist is the only thing that can work.
    expect(res.headers["access-control-allow-credentials"]).toBe("true")
  })

  it("never answers with a wildcard", async () => {
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .get("/health")
      .set("origin", ORIGIN)

    expect(res.headers["access-control-allow-origin"]).not.toBe("*")
  })

  it("omits the header entirely for an origin that is not on the list", async () => {
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .get("/health")
      .set("origin", "https://evil.example.com")

    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("answers a preflight with the headers the client actually sends", async () => {
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .options("/api/transfers")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "idempotency-key")

    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN)
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toContain("idempotency-key")
  })

  it("lets a caller with no Origin through", async () => {
    // Server-side callers, health probes and curl send none. CORS governs what
    // one browser tab may do to another; it is not authentication, and
    // treating it as such is how an API ends up believed to be protected.
    const res = await request(app({ CORS_ORIGINS: ORIGIN })).get("/health")
    expect(res.status).toBe(200)
  })
})

describe("rate limiting (§17.1 denial of service, §17.3)", () => {
  it("throttles registration far sooner than the global budget", async () => {
    // Registration being unthrottled is what made FR-4.9's per-user lookup cap
    // decorative: identities cost about 54ms each, so an enumerator could mint
    // thousands and buy twenty lookups with every one (P-20).
    const instance = app()
    const statuses: number[] = []

    for (let i = 0; i < 24; i++) {
      const res = await request(instance)
        .post("/api/auth/register")
        .send({ phone: "+998901234567", firstName: "A", lastName: "B", password: "x" })
      statuses.push(res.status)
    }

    const throttled = statuses.filter((status) => status === 429)
    expect(throttled.length, `statuses: ${statuses.join(",")}`).toBeGreaterThan(0)
    // Well under the 300-request global budget, so the tighter limit is the one
    // that fired.
    expect(statuses.indexOf(429)).toBeLessThan(24)
  })

  it("answers a throttled caller with the §12.3 envelope", async () => {
    const instance = app()

    let throttled: request.Response | undefined
    for (let i = 0; i < 24; i++) {
      const res = await request(instance)
        .post("/api/auth/login")
        .send({ phone: "+998901234567", password: "x" })
      if (res.status === 429) {
        throttled = res
        break
      }
    }

    expect(throttled).toBeDefined()
    // Not express-rate-limit's own plain-text body: a client parses every
    // failure with this schema, and one that does not fit breaks its error path.
    expect(apiErrorSchema.safeParse(throttled?.body).success).toBe(true)
    expect(throttled?.body.error.code).toBe("RATE_LIMITED")
    expect(throttled?.body.error.requestId).toBe(throttled?.headers["x-request-id"])
  })

  it("advertises the limit in standard headers", async () => {
    const res = await request(app()).get("/health")
    // draft-7 RateLimit header, so a well-behaved client can back off before
    // being refused rather than after.
    expect(res.headers.ratelimit ?? res.headers["ratelimit-limit"]).toBeDefined()
  })

  it("does not throttle a normal amount of ordinary traffic", async () => {
    // A limit that fires on legitimate use is an outage with a nicer name.
    const instance = app()
    const statuses: number[] = []

    for (let i = 0; i < 30; i++) {
      const res = await request(instance)
        .post("/api/transfers")
        .set("idempotency-key", randomUUID())
        .send({ phone: "+998901234567", amount: "300000" })
      statuses.push(res.status)
    }

    // All refused for want of a token, none for rate limiting.
    expect(statuses.every((status) => status === 401)).toBe(true)
  })
})
