import request from "supertest"
import { describe, expect, it } from "vitest"
import { buildApp, PRISMA_STUB } from "./helpers.js"

/**
 * The global budget actually fires, and the USSD callback actually escapes it.
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

  it("does not spend that budget on the USSD gateway callback", async () => {
    /*
     * P-33's exemption. A carrier gateway is one address for a whole network,
     * so the address-keyed budget would take the channel away from everybody
     * behind it; `ussdGatewayRateLimit` meters that path per subscriber
     * instead.
     *
     * Asserted by exhausting the global budget first and then showing the
     * callback still answers — the strongest form of "this path is exempt",
     * and one that a per-request store would also have passed, which is why it
     * is paired with the test above rather than standing alone.
     */
    const { app } = buildApp(PRISMA_STUB, { ...process.env })
    const agent = request.agent(app)

    for (let i = 0; i < GLOBAL_MAX + 1; i += 1) await agent.get("/api/nothing-here")
    expect((await agent.get("/api/nothing-here")).status, "the budget is not spent").toBe(429)

    /*
     * Answered by the route rather than by the limiter. No gateway secret is
     * configured here, so the route refuses it — with a 401, which is the
     * route's own decision and proof the request reached it.
     */
    const callback = await agent
      .post("/api/channels/ussd")
      .send({ sessionId: "s", phoneNumber: "+998901234567", serviceCode: "*880#", text: "" })

    expect(callback.status, "the global budget swallowed the callback").not.toBe(429)
  }, 120_000)
})
