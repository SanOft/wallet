import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { buildApp, PRISMA_STUB } from "./helpers.js"

/**
 * What `trust proxy` actually resolves to, measured rather than reasoned about
 * (P-11).
 *
 * Every rate limit keys on `req.ip`, so the hop count decides which of two
 * failures you get: too low and one proxy's address stands in for every caller,
 * putting the whole world in one budget; too high and a caller can forge the
 * header and mint budgets at will. The entry records that the count was chosen
 * for the chain that existed before ADR-0009 put a second proxy in front, and
 * that "what each vendor puts in `X-Forwarded-For` is a claim about runtime
 * behaviour and has to be measured".
 *
 * This file measures the half that can be measured here — what Express does
 * with a given count — and pins the value the application sets. It cannot know
 * how many hops production really has; that is T-6.3's job against the deployed
 * origin. What it removes is the other unknown, so that when the measurement
 * arrives the only open question is a number.
 */

/** A chain as a gateway would send it: client first, nearest proxy last. */
const CLIENT = "203.0.113.9"
const CDN = "198.51.100.7"
const BALANCER = "192.0.2.5"

async function resolvedIp(trust: number, forwardedFor: string): Promise<string> {
  const app = express()
  app.set("trust proxy", trust)
  app.get("/probe", (req, res) => {
    res.json({ ip: req.ip })
  })

  const res = await request(app).get("/probe").set("x-forwarded-for", forwardedFor)
  return String(res.body.ip)
}

describe("how many proxies the API believes are in front of it", () => {
  it("sets one hop, which is the number production has to confirm", () => {
    const { app } = buildApp(PRISMA_STUB, { ...process.env })

    /*
     * Pinned so the value cannot drift silently. It is deliberately not
     * asserted as *correct*: whether one is right depends on the deployed
     * chain, and the table below is what says what changing it would mean.
     */
    expect(app.get("trust proxy")).toBe(1)
  })

  it.each([
    { trust: 1, chain: [CLIENT], resolves: CLIENT, note: "no proxy: the caller" },
    { trust: 1, chain: [CLIENT, CDN], resolves: CDN, note: "one proxy: the proxy, not the caller" },
    { trust: 1, chain: [CLIENT, CDN, BALANCER], resolves: BALANCER, note: "two proxies: the last" },
    { trust: 2, chain: [CLIENT, CDN], resolves: CLIENT, note: "one proxy: the caller" },
    { trust: 2, chain: [CLIENT, CDN, BALANCER], resolves: CDN, note: "two proxies: the middle" },
  ])(
    "trust=$trust over $chain resolves to $resolves — $note",
    async ({ trust, chain, resolves }) => {
      /*
       * Express counts hops from the right, nearest the application. So the
       * count is not "how many proxies exist", it is "how many of them may be
       * believed", and one too few silently returns a proxy's own address.
       */
      expect(await resolvedIp(trust, chain.join(", "))).toBe(resolves)
    },
  )

  it("puts two callers behind one proxy in the same rate-limit bucket", async () => {
    /*
     * The consequence, on the real application rather than on a probe.
     *
     * ADR-0009 serves the API through the web origin, so a request arrives as
     * at least `client, vercel`. With one trusted hop the table above says
     * `req.ip` is the proxy — identical for everyone — and this is what that
     * costs: one caller's traffic exhausts another's budget, which is an
     * availability failure that reads like a security control working.
     *
     * Asserted as a *fact about the current setting*, not as desired
     * behaviour. When T-6.3 measures the real chain and the count changes,
     * this test is where the change announces itself.
     */
    const { app } = buildApp(PRISMA_STUB, { ...process.env })
    const agent = request.agent(app)

    const statuses: number[] = []
    for (let i = 0; i < 24; i++) {
      // A different caller every time, all behind the same proxy.
      const res = await agent
        .post("/api/auth/register")
        .set("x-forwarded-for", `203.0.113.${i}, ${CDN}`)
        .send({ phone: "+998901234567", firstName: "A", lastName: "B", password: "x" })
      statuses.push(res.status)
    }

    expect(
      statuses.filter((status) => status === 429).length,
      "twenty-four distinct callers shared one budget, or they did not",
    ).toBeGreaterThan(0)
  }, 30_000)
})
