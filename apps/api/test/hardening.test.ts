import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { apiErrorSchema } from "@wallet/shared"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { loadEnv } from "../src/config/env.js"
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

  it("forbids every cache from storing a response", async () => {
    // A CDN sits in front of this service (ADR-0009), and Vercel honours
    // upstream cache headers on external rewrites by default. A cached
    // `GET /api/accounts` is one user's balance shown to another.
    const res = await request(app()).get("/health")
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("forbids it on an authenticated route and on an error too", async () => {
    const missing = await request(app()).get("/api/accounts")
    expect(missing.status).toBe(401)
    expect(missing.headers["cache-control"]).toBe("no-store")

    const notFound = await request(app()).get("/api/does-not-exist")
    expect(notFound.headers["cache-control"]).toBe("no-store")
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

  it("tells a refused caller nothing about which routes exist", async () => {
    // A refused preflight used to fall through to Express's automatic OPTIONS
    // handler: 200 with `Allow: POST` and the verb list as a plain-text body on
    // a real route, 404 on an invented one. Unauthenticated route discovery,
    // handed to exactly the origin CORS had just refused.
    const instance = app({ CORS_ORIGINS: ORIGIN })

    const real = await request(instance)
      .options("/api/transfers")
      .set("origin", "https://evil.example.com")
      .set("access-control-request-method", "POST")

    const invented = await request(instance)
      .options("/api/there-is-no-such-route")
      .set("origin", "https://evil.example.com")
      .set("access-control-request-method", "POST")

    expect(real.status).toBe(invented.status)
    expect(real.headers.allow).toBeUndefined()
    expect(invented.headers.allow).toBeUndefined()
    expect(real.headers["access-control-allow-origin"]).toBeUndefined()
    expect(real.text).toBe("")
  })

  it("declares that its answer depends on the origin, even when refusing", async () => {
    // Both variants of the same URL must vary on Origin, or a shared cache can
    // hand the header-less one to an allowlisted caller.
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .get("/health")
      .set("origin", "https://evil.example.com")

    expect(res.headers.vary ?? "").toContain("Origin")
  })

  it("exposes the headers a throttled client has to read", async () => {
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .get("/health")
      .set("origin", ORIGIN)

    // §12.3 renders "try again in X minutes" from Retry-After. Cross-origin, a
    // header the server sends is invisible to JS unless it is exposed.
    const exposed = (res.headers["access-control-expose-headers"] ?? "").toLowerCase()
    expect(exposed).toContain("retry-after")
    expect(exposed).toContain("ratelimit")
  })

  it("lets a caller with no Origin through", async () => {
    // Server-side callers, health probes and curl send none. CORS governs what
    // one browser tab may do to another; it is not authentication, and
    // treating it as such is how an API ends up believed to be protected.
    const res = await request(app({ CORS_ORIGINS: ORIGIN })).get("/health")
    expect(res.status).toBe(200)
  })
})

describe("the deploy topology the cookie policy depends on (ADR-0009)", () => {
  /*
   * These assertions are about a file in another workspace, and they live here
   * because this is the workspace they protect. `SameSite=Strict` on the
   * refresh cookie only works while the PWA and the API share an origin, and
   * that is true only because of the rewrite below. Delete the rewrite and
   * every session silently stops renewing — in production, not in any test that
   * uses supertest against one host.
   */
  const config = JSON.parse(
    readFileSync(new URL("../../web/vercel.json", import.meta.url), "utf8"),
  ) as {
    rewrites?: { source: string; destination: string }[]
    headers?: { source: string; headers: { key: string; value: string }[] }[]
  }

  it("routes /api through the web origin", () => {
    const rewrite = config.rewrites?.find((r) => r.source.startsWith("/api"))
    expect(rewrite, "no /api rewrite — the refresh cookie cannot work").toBeDefined()
    expect(rewrite?.destination).toMatch(/^https:\/\//)
  })

  it("keeps the CDN from storing anything the API returns", () => {
    // Vercel honours upstream cache headers on external rewrites by default for
    // projects created on or after 6 April 2026. The API also sends no-store;
    // both exist because one silent failure here leaks a balance across users.
    const rule = config.headers?.find((h) => h.source.startsWith("/api"))
    const disabled = rule?.headers.find((h) => h.key === "x-vercel-enable-rewrite-caching")
    expect(disabled?.value).toBe("0")
  })
})

describe("the allowlist is validated, not merely described (NFR-1.8)", () => {
  function withOrigins(value: string) {
    return () =>
      loadEnv({
        DATABASE_URL: "postgresql://unused",
        JWT_SECRET: "x".repeat(32),
        CORS_ORIGINS: value,
      })
  }

  it("refuses a wildcard", () => {
    // The comment above this variable said NFR-1.8 forbids `*`. The schema
    // checked only that the string was non-empty.
    expect(withOrigins("*")).toThrow(/CORS_ORIGINS/)
    expect(withOrigins("https://wallet.example.com,*")).toThrow(/CORS_ORIGINS/)
  })

  it("refuses the literal origin `null`", () => {
    // Not a curiosity: sandboxed iframes and `data:` documents send it, and the
    // policy grants credentials. A deploy template rendering an unset variable
    // as "null" would have opened it.
    expect(withOrigins("null")).toThrow(/CORS_ORIGINS/)
  })

  it("refuses plaintext for anything but localhost", () => {
    expect(withOrigins("http://wallet.example.com")).toThrow(/https/)
    expect(withOrigins("http://localhost:5173")).not.toThrow()
  })

  it("normalises what a dashboard is likely to contain", () => {
    // A mixed-case or trailing-slash entry produced an allowlist that could
    // never match the origin a browser actually sends — a failure that looks
    // like a CORS bug and invites a wildcard as the fix.
    const env = loadEnv({
      DATABASE_URL: "postgresql://unused",
      JWT_SECRET: "x".repeat(32),
      CORS_ORIGINS: "https://Wallet.Example.com/, https://api.example.com",
    })
    expect(env.CORS_ORIGINS).toEqual(["https://wallet.example.com", "https://api.example.com"])
  })
})

describe("a hosted deployment must declare itself production (F18)", () => {
  function withNodeEnv(nodeEnv: string | undefined, renderGitCommit: string | undefined) {
    return () =>
      loadEnv({
        DATABASE_URL: "postgresql://unused",
        JWT_SECRET: "x".repeat(32),
        CORS_ORIGINS: "https://wallet.example.com",
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
        ...(renderGitCommit === undefined ? {} : { RENDER_GIT_COMMIT: renderGitCommit }),
      })
  }

  it("refuses to boot on Render's platform without NODE_ENV=production", () => {
    // RENDER_GIT_COMMIT is set by the platform itself, not by a deploy
    // template — a process running there that still thinks it is a laptop is
    // the state that sends an insecure cookie (cookies.ts) and skips the
    // CORS_ORIGINS check this same superRefine already enforces above.
    expect(withNodeEnv("development", "abc")).toThrow(/NODE_ENV must be production/)
  })

  it("leaves a laptop, and a correctly configured deployment, alone", () => {
    expect(withNodeEnv("development", undefined)).not.toThrow()
    expect(withNodeEnv("production", "abc")).not.toThrow()
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
    /*
     * Sixty, because the login budget counts *failures* and allows fifty
     * (P-25). Twenty-four was enough when it counted every attempt and allowed
     * twenty; against the new control it never fired, and the test said the
     * envelope was missing when what was missing was the throttle.
     *
     * Every request here fails — `PRISMA_STUB` cannot answer a query, so the
     * route 500s — which is what makes this a clean probe of the limiter: a
     * 429 cannot have come from FR-2.3's backoff, because nothing reached the
     * database to count against it.
     */
    const instance = app()

    let throttled: request.Response | undefined
    for (let i = 0; i < 60; i++) {
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

  it("advertises the exact global budget, not merely a budget", async () => {
    // The header's presence was asserted; its value was not. Raising the limit
    // from 300 to 100 000 left the whole suite green, which made §17.1's
    // denial-of-service row unfalsifiable.
    const res = await request(app()).get("/health")
    const header = res.headers.ratelimit ?? res.headers["ratelimit-limit"] ?? ""
    expect(header).toContain("limit=300")
  })

  it("a forwarded-for that is not an address does not mint a fresh budget", async () => {
    // Every distinct string used to become its own counter, so thirty requests
    // carrying thirty different garbage values were never throttled once. They
    // share one bucket now.
    const instance = app()
    const statuses: number[] = []

    for (let i = 0; i < 24; i++) {
      const res = await request(instance)
        .post("/api/auth/register")
        .set("x-forwarded-for", `not-an-ip-${i}`)
        .send({ phone: "+998901234567", firstName: "A", lastName: "B", password: "x" })
      statuses.push(res.status)
    }

    expect(
      statuses.filter((s) => s === 429).length,
      `statuses: ${statuses.join(",")}`,
    ).toBeGreaterThan(0)
  })

  it("counts a preflight and gives it an identity", async () => {
    // Both limiters and `requestId` used to be mounted after CORS, which
    // answers an allowed preflight itself — so five hundred of them cost
    // nothing and appeared in no log.
    const res = await request(app({ CORS_ORIGINS: ORIGIN }))
      .options("/api/transfers")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST")

    expect(res.headers["x-request-id"]).toBeDefined()
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
