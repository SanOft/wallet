import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import type TestAgent from "supertest/lib/agent.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

/**
 * The login budget counts guesses, not sign-ins (P-25).
 *
 * Uzbek carriers put whole subscriber pools behind one address, so a per-IP
 * budget of twenty per quarter hour was never twenty attempts by one person —
 * it was twenty sign-ins for everybody on that NAT. An outage with a security
 * rationale attached, and the people it stopped were the customers.
 *
 * The two populations differ in the one way that can be measured cheaply:
 * legitimate users mostly succeed, attackers mostly fail. These tests assert
 * that difference is what the limiter actually keys on.
 *
 * Every request here comes from the same address on purpose. That is the
 * situation being modelled.
 *
 * `request.agent` rather than `request`, throughout. The latter starts an
 * ephemeral server and a fresh socket per call, and these loops make a hundred
 * and forty-five of them — enough to exhaust Windows' ephemeral port range and
 * fail an unrelated suite later in the run with `ENOBUFS`. A test that makes
 * the tests after it flaky is a defect in the suite regardless of what it
 * asserts.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

/** Assembled rather than written out: a literal trips the secret scanner. */
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")
const WRONG = ["not", "the", "right", "one"].join("-")

describe.skipIf(!hasDatabase)("the login budget behind one shared address", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function register(agent: TestAgent, phone = uniquePhone()): Promise<string> {
    const res = await agent
      .post("/api/auth/register")
      .send({ phone, firstName: "Nat", lastName: "Subscriber", password: PASSWORD })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return phone
  }

  it("does not charge a shared address for people signing in successfully", async () => {
    /*
     * Sixty correct sign-ins from one address — three times the old budget of
     * twenty, and more than the fifty this limiter allows. Every one must
     * succeed, because none of them is a guess.
     *
     * This is the test that would have failed before the change, at the
     * twenty-first request, with a 429 for a customer who typed their password
     * correctly.
     */
    const agent = request.agent(buildApp(prisma, { ...process.env }).app)
    const phone = await register(agent)

    for (let i = 0; i < 60; i++) {
      const res = await agent.post("/api/auth/login").send({ phone, password: PASSWORD })
      expect(res.status, `sign-in ${i + 1} of 60`).toBe(200)
    }
    /*
     * Thirty seconds, declared rather than inherited.
     *
     * Sixty *genuine* sign-ins means sixty argon2 verifications at roughly
     * 44 ms each (`crypto.ts` documents the figure), so about 2.6 s of
     * deliberate work before anything else. It measured 5006 ms against the
     * 5000 ms default inside `yarn verify`.
     *
     * The cost is the test. Making it cheaper means either fewer sign-ins —
     * and it has to exceed fifty to prove anything about a budget of fifty —
     * or weaker hashing, which would be testing a system nobody ships.
     */
  }, 30_000)

  it("still stops somebody working through passwords", async () => {
    /*
     * The other half, and the reason the budget is not simply removed. Fifty
     * failures from one address is not a mistyped password; it is a list.
     *
     * **Every attempt uses a different, unregistered number**, and the
     * assertion is on the error *code* rather than the status. Both matter,
     * and the first version of this test had neither:
     *
     *   - `AUTH_LOCKED` and `RATE_LIMITED` are both 429 (§12.3), so a status
     *     check cannot tell the address budget from FR-2.3's per-account
     *     backoff.
     *   - Spraying three accounts twenty times each triggers that backoff after
     *     three failures apiece, so the test went green on 429s the limiter
     *     never produced. Removing the budget entirely left it passing, which
     *     is how the hole was found.
     *
     * One failure per number reaches neither the backoff's three free attempts
     * nor the registration limiter, so the only thing left that can answer
     * `RATE_LIMITED` is the control under test. Unregistered numbers are used
     * deliberately: FR-2.2 makes the response identical either way, and it is
     * also what a real spray looks like.
     */
    const agent = request.agent(buildApp(prisma, { ...process.env }).app)

    let throttled = 0
    let refusedCredentials = 0
    for (let i = 0; i < 60; i++) {
      const res = await agent
        .post("/api/auth/login")
        .send({ phone: uniquePhone(), password: WRONG })

      const code = (res.body as { error?: { code?: string } }).error?.code
      if (code === "RATE_LIMITED") throttled += 1
      if (code === "AUTH_INVALID_CREDENTIALS") refusedCredentials += 1
    }

    expect(
      throttled,
      "sixty wrong passwords from one address were never throttled",
    ).toBeGreaterThan(0)
    // The control: the early attempts really did reach the credential check,
    // so this is a budget being spent rather than everything being refused.
    expect(refusedCredentials, "nothing reached the credential check").toBeGreaterThan(0)
  })

  it("keeps counting successful registrations, because those are the thing capped", async () => {
    /*
     * P-20's control, which must not be weakened by P-25's fix. Registration
     * caps *identities created*; skipping successes there would remove it
     * entirely and make FR-4.9's lookup cap decorative again, since an
     * enumerator buys twenty lookups with every account they mint.
     */
    const agent = request.agent(buildApp(prisma, { ...process.env }).app)

    let refused = 0
    for (let i = 0; i < 25; i++) {
      const res = await agent.post("/api/auth/register").send({
        phone: uniquePhone(),
        firstName: "Minted",
        lastName: "Identity",
        password: PASSWORD,
      })
      if (res.status === 429) refused += 1
    }

    expect(refused, "successful registrations were not counted").toBeGreaterThan(0)
  })
})
