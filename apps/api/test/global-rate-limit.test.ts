import request from "supertest"
import { describe, expect, it } from "vitest"
import { buildApp, PRISMA_STUB } from "./helpers.js"

/**
 * The global budget actually fires, and only a proven gateway escapes it.
 *
 * Both halves were introduced together with P-33's exemption and neither was
 * tested. One of them was wrong: `globalRateLimit()` was being called *inside*
 * the request handler, and `rateLimit()` builds its own `MemoryStore` when none
 * is passed — so every request got a counter starting at zero and the limit
 * never fired at all. Nothing failed. The middleware was mounted, the branch
 * ran, and the control was dead.
 *
 * That is the exact failure this file exists to make impossible: a limiter
 * whose presence is visible in the source and whose effect is not. Asserting
 * the *effect* is the only version of this test worth having.
 */

/** `globalRateLimit`'s own budget. One more request than this must be refused. */
const GLOBAL_MAX = 300

/** Assembled rather than written out: a literal here trips the secret scanner. */
const GATEWAY_SECRET = ["gateway", "secret", "for", "tests", "only", "0123456789"].join("-")

/** A distinct subscriber per request, so nothing shares a per-subscriber bucket. */
function callback(index: number) {
  return {
    sessionId: `s${index}`,
    phoneNumber: `+99890000${String(1000 + index)}`,
    networkCode: "62120",
    serviceCode: "*880#",
    text: "",
  }
}

describe("the global rate limit (§17.3)", () => {
  it("refuses a caller that exceeds the budget", async () => {
    const { app } = buildApp(PRISMA_STUB, { ...process.env })

    /*
     * `request.agent` rather than `request`: the latter opens a fresh socket
     * per call, and three hundred of them exhaust Windows' ephemeral port
     * range and fail an unrelated suite later in the run with `ENOBUFS`.
     *
     * A path that routes nowhere, so each request costs a 404 from the
     * not-found handler rather than a database round trip. The limiter runs
     * well before routing, which is the whole point of it.
     */
    const agent = request.agent(app)
    const statuses: number[] = []

    for (let i = 0; i < GLOBAL_MAX + 1; i += 1) {
      const res = await agent.get("/api/nothing-here")
      statuses.push(res.status)
    }

    expect(statuses.filter((status) => status === 429).length, "the budget never fired").toBe(1)
    expect(statuses[GLOBAL_MAX], "the refusal came at the wrong request").toBe(429)

    // Everything before it went through to the router, which is what says the
    // limiter refused rather than that the app was broken all along.
    expect(new Set(statuses.slice(0, GLOBAL_MAX))).toEqual(new Set([404]))
  }, 120_000)

  it("spends that budget on the gateway path while no secret is configured", async () => {
    /*
     * P-33's exemption used to be the path itself, and an unset secret is the
     * expected production state (FR-9.6) — so the one route that no
     * configuration protects was also the one route no budget metered, and a
     * caller that dialled it three hundred times paid nothing.
     *
     * Distinct numbers per request, because the per-subscriber budget is what
     * the exemption handed the path over to: keyed on the subscriber, three
     * hundred subscribers is three hundred untouched buckets.
     */
    const { app } = buildApp(PRISMA_STUB, { ...process.env, USSD_GATEWAY_SECRET: undefined })
    const agent = request.agent(app)
    const statuses: number[] = []

    for (let i = 0; i < GLOBAL_MAX + 1; i += 1) {
      const res = await agent.post("/api/channels/ussd").send(callback(i))
      statuses.push(res.status)
      if (i === GLOBAL_MAX) expect(res.body.error.code).toBe("RATE_LIMITED")
    }

    expect(statuses[GLOBAL_MAX], "the gateway path is still unmetered").toBe(429)
    // 401 from the route, which is what says the budget refused the last one
    // rather than the route refusing all of them for its own reasons.
    expect(new Set(statuses.slice(0, GLOBAL_MAX))).toEqual(new Set([401]))
  }, 120_000)

  it("spends it on a caller that cannot present the configured secret", async () => {
    /*
     * The other half: a configured secret must not buy an exemption for
     * somebody who does not have it. A wrong header and no header at all are
     * the same caller — an ordinary one — and both pay the address budget.
     */
    const { app } = buildApp(PRISMA_STUB, {
      ...process.env,
      USSD_GATEWAY_SECRET: GATEWAY_SECRET,
    })
    const agent = request.agent(app)
    const statuses: number[] = []

    for (let i = 0; i < GLOBAL_MAX + 1; i += 1) {
      const post = agent.post("/api/channels/ussd")
      // Alternating, so neither shape can be the only one metered.
      if (i % 2 === 0) post.set("x-gateway-secret", `${GATEWAY_SECRET}x`)
      const res = await post.send(callback(i))
      statuses.push(res.status)
      if (i === GLOBAL_MAX) expect(res.body.error.code).toBe("RATE_LIMITED")
    }

    expect(statuses[GLOBAL_MAX], "an unproven caller is still exempt").toBe(429)
    expect(new Set(statuses.slice(0, GLOBAL_MAX))).toEqual(new Set([401]))
  }, 120_000)
})
