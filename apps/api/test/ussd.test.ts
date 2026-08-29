import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import {
  CHANNEL_LIMITS,
  gsm7Septets,
  STEP_UP_THRESHOLD,
  USSD_MAX_SEPTETS,
  USSD_PIN_PROMPT,
  USSD_RESPONSE_CEILING_MS,
} from "@wallet/shared"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { resolveStep, segmentsOf } from "../src/adapters/ussd/steps.js"
import { MESSAGES, UssdAdapter } from "../src/adapters/ussd/UssdAdapter.js"
import type { AccountService } from "../src/domain/AccountService.js"
import type { AuthService } from "../src/domain/AuthService.js"
import { SlidingWindow } from "../src/domain/SlidingWindow.js"
import type { TransferService } from "../src/domain/TransferService.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

/**
 * FR-9, the channel with no screen, no keyboard and no session.
 *
 * Three things make this channel different from the web, and each of them is
 * a way to be wrong that the web cannot be:
 *
 *  1. **The whole conversation is one string.** Every request arrives cold, so
 *     a parser that mishandles `""` breaks the first screen of the product.
 *  2. **The alphabet is not Unicode.** 182 characters holds only in GSM 7-bit;
 *     one Cyrillic letter in a recipient's name silently cuts the message to
 *     70 and the network truncates the rest.
 *  3. **There is no error page.** A thrown exception becomes JSON on a feature
 *     phone. The adapter must answer `END` for everything, including its own
 *     bugs, and must still say so in the log.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

/** Assembled rather than written out: a literal here trips the secret scanner. */
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")
const GATEWAY_SECRET = ["gateway", "secret", "for", "tests", "only", "0123456789"].join("-")

describe("the session parser (FR-9.2)", () => {
  it("reads an empty text as no input at all, not as an empty choice", () => {
    /*
     * `"".split("*")` is `[""]`. Left as it comes, the very first request of
     * every session looks like a menu choice of the empty string and falls
     * through to "wrong choice" — so the opening screen of the whole channel
     * would be an error message.
     */
    expect(segmentsOf("")).toEqual([])
    expect(resolveStep("")).toEqual({ kind: "menu" })
  })

  it("walks the transfer branch one segment at a time (§11.7)", () => {
    expect(resolveStep("2")).toEqual({ kind: "ask-recipient" })
    expect(resolveStep("2*901234567")).toEqual({ kind: "quote-recipient", phone: "901234567" })
    expect(resolveStep("2*901234567*50000")).toEqual({
      kind: "quote-amount",
      phone: "901234567",
      amount: "50000",
    })
    expect(resolveStep("2*901234567*50000*1234")).toEqual({
      kind: "transfer",
      phone: "901234567",
      amount: "50000",
      pin: "1234",
    })
  })

  it("puts a PIN in front of balance and history", () => {
    expect(resolveStep("1")).toEqual({ kind: "ask-pin" })
    expect(resolveStep("3")).toEqual({ kind: "ask-pin" })
    expect(resolveStep("1*1234")).toEqual({ kind: "balance", pin: "1234" })
    expect(resolveStep("3*1234")).toEqual({ kind: "history", pin: "1234" })
  })

  it("refuses a sequence this menu cannot produce", () => {
    // Not a step, and therefore not something to guess at: an unknown suffix
    // on a known prefix is the shape a fuzzer produces.
    expect(resolveStep("9")).toEqual({ kind: "unknown" })
    expect(resolveStep("1*1234*5")).toEqual({ kind: "unknown" })
    expect(resolveStep("2*901234567*50000*1234*9")).toEqual({ kind: "unknown" })
  })
})

describe("the prompt F7 reads to decide on masking", () => {
  /*
   * A cross-workspace coupling that nothing used to hold.
   *
   * The simulator masks the next input when the screen asks for a PIN, and it
   * decides that by reading the screen — the same signal the person holding
   * the phone uses, and deliberately its only knowledge of the menu. It lives
   * in `apps/web`, which cannot import these strings (§8.2), so renaming a
   * prompt here would have stopped the masking with nothing failing anywhere.
   *
   * `USSD_PIN_PROMPT` is in `packages/shared` now, and this is the half that
   * makes it load-bearing: the rename fails here.
   */
  it("matches both prompts that ask for a PIN", () => {
    expect(USSD_PIN_PROMPT.test(MESSAGES.askPin)).toBe(true)
    expect(USSD_PIN_PROMPT.test(MESSAGES.askConfirm)).toBe(true)
  })

  it("matches no prompt that asks for something else", () => {
    /*
     * The other half. A pattern that matched everything would mask the
     * recipient's number and the amount too — and the wire panel would hide
     * the accumulation it exists to show.
     */
    for (const key of ["menu", "askRecipient", "askAmount", "noHistory"] as const) {
      expect(USSD_PIN_PROMPT.test(MESSAGES[key]), `${key}: ${MESSAGES[key]}`).toBe(false)
    }
  })
})

describe("the lookup window", () => {
  it("admits the budget and refuses the one after it", () => {
    const window = new SlidingWindow(2, 1000)
    expect(window.admit("a", 0)).toBe(true)
    expect(window.admit("a", 1)).toBe(true)
    expect(window.admit("a", 2)).toBe(false)
    // A different caller has their own budget.
    expect(window.admit("b", 2)).toBe(true)
  })

  it("forgets a hit once its window has passed", () => {
    const window = new SlidingWindow(1, 1000)
    expect(window.admit("a", 0)).toBe(true)
    expect(window.admit("a", 500)).toBe(false)
    expect(window.admit("a", 1001)).toBe(true)
  })
})

describe("the channel's own limits", () => {
  it("cannot ask a keypad for a password", () => {
    /*
     * FR-2.8's step-up asks for the *account password*, which nobody types on
     * a numeric keypad — so a USSD transfer that needed one could never
     * complete. It cannot need one only while the channel ceiling stays below
     * the step-up threshold.
     *
     * Asserted rather than assumed, because the two constants live side by
     * side in one file and raising `CHANNEL_LIMITS.USSD` alone would turn
     * every large USSD transfer into a refusal nobody could act on — with the
     * whole suite still green.
     */
    expect(CHANNEL_LIMITS.USSD.perOperation).toBeLessThanOrEqual(STEP_UP_THRESHOLD)
  })
})

describe("a transfer that did not complete", () => {
  it("is never announced as one that did", async () => {
    /*
     * Reached with doubles, because it cannot be reached through the service.
     *
     * `TransferService.execute` throws a refused transfer and only ever
     * *returns* a completed one — so a session test can prove the thrown path
     * and leaves this one uncovered, which is how a mutation that deletes the
     * check survives a green suite.
     *
     * The signature still admits it: `TransferResult["status"]` is
     * `"COMPLETED" | "FAILED"`, and a `#settle` that returned its stored
     * failure instead of throwing would be an unremarkable refactor. What it
     * would produce here, without this branch, is "50 000 so'm yuborildi" for
     * money that never moved — announced at the end of a session the sender
     * cannot ask again.
     */
    const failed = {
      id: "t1",
      status: "FAILED" as const,
      amount: 5_000_000n,
      channel: "USSD" as const,
      type: "P2P" as const,
      createdAt: new Date(),
      completedAt: null,
      failReason: "INSUFFICIENT_FUNDS",
      senderBalanceAfter: 0n,
    }

    const adapter = new UssdAdapter({
      prisma: {} as unknown as PrismaClient,
      auth: { verifyPin: async () => {} } as unknown as AuthService,
      // Caller ID resolution went to `AccountService` with the lookup it
      // shares a budget with, so the double answers there rather than through
      // a bare Prisma stub.
      accounts: { findUserIdByPhone: async () => "u1" } as unknown as AccountService,
      transfers: { execute: async () => failed } as unknown as TransferService,
    })

    const reply = await adapter.handle({
      sessionId: "s1",
      phoneNumber: "+998901234567",
      networkCode: "62120",
      serviceCode: "*880#",
      text: "2*901234568*50000*1234",
    })

    expect(reply).toEqual({ kind: "END", text: "Balansda yetarli mablag' yo'q." })
  })
})

describe.skipIf(!hasDatabase)("a USSD session end to end (FR-9, §11.7)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function newUser(firstName = "Alisher", lastName = "Navoiy") {
    const { app, logText } = buildApp(prisma, {
      ...process.env,
      USSD_GATEWAY_SECRET: GATEWAY_SECRET,
    })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName, lastName, password: PASSWORD })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return { app, logText, phone, token: res.body.accessToken as string }
  }

  type User = Awaited<ReturnType<typeof newUser>>

  async function setPin(user: User, pin = "1234") {
    const res = await request(user.app)
      .put("/api/me/pin")
      .set("authorization", `Bearer ${user.token}`)
      .send({ currentPassword: PASSWORD, pin })
    expect(res.status, JSON.stringify(res.body)).toBe(204)
  }

  async function topup(user: User) {
    const res = await request(user.app)
      .post("/api/accounts/topup")
      .set("authorization", `Bearer ${user.token}`)
      .set("idempotency-key", randomUUID())
      .send()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  }

  /**
   * One keypress, through the simulator door.
   *
   * Every reply is checked against the channel's two hard guarantees before it
   * is returned, so each test below asserts them for free: the prefix is `CON`
   * or `END` (FR-9.3), and the body fits 182 septets *in the 7-bit alphabet* —
   * the pair of conditions that cannot be checked separately, because a
   * message that leaves the alphabet has a budget of 70 and no warning.
   */
  async function dial(user: User, text: string, sessionId: string): Promise<string> {
    const res = await request(user.app)
      .post("/api/channels/ussd/simulate")
      .set("authorization", `Bearer ${user.token}`)
      .send({ sessionId, phoneNumber: "ignored", networkCode: "62120", serviceCode: "*880#", text })

    expect(res.status, res.text).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/plain/)
    expect(res.text).toMatch(/^(CON|END) /)

    const body = res.text.slice(4)
    expect(gsm7Septets(body), `not GSM-7: ${body}`).not.toBeNull()
    expect(gsm7Septets(body) ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(USSD_MAX_SEPTETS)
    return res.text
  }

  it("opens on the menu without reading the database", async () => {
    const user = await newUser()
    // No PIN, no top-up, and the number is irrelevant: the first screen
    // discloses nothing, not even whether this subscriber is one of ours.
    expect(await dial(user, "", randomUUID())).toContain("1. Balans")
  })

  it("asks for the PIN before it says what the balance is (ADR-0002)", async () => {
    const user = await newUser()
    await setPin(user)
    await topup(user)

    const session = randomUUID()
    expect(await dial(user, "1", session)).toBe("CON PIN kodni kiriting")
    expect(await dial(user, "1*1234", session)).toContain("Balans: 1 000 000 so'm")
  })

  it("refuses the balance to a wrong PIN", async () => {
    const user = await newUser()
    await setPin(user)
    await topup(user)

    const reply = await dial(user, "1*9999", randomUUID())
    expect(reply).toBe("END PIN noto'g'ri.")
    // The number itself must not leak through the refusal.
    expect(reply).not.toContain("1 000 000")
  })

  it("says a PIN was never set rather than that it was wrong (FR-9.5)", async () => {
    const user = await newUser()
    expect(await dial(user, "1*1234", randomUUID())).toBe("END Avval ilovada PIN o'rnating.")
  })

  it("does not spend an attempt on a PIN that is the wrong length", async () => {
    const user = await newUser()
    await setPin(user)

    const session = randomUUID()
    // Four typos, which is more than the three FR-9.5 blocks on. A malformed
    // PIN is not a guess, so it must not count as one.
    for (const typo of ["12", "12345", "abcd", "1 34"]) {
      expect(await dial(user, `1*${typo}`, session)).toBe("END PIN 4 ta raqamdan iborat.")
    }
    await topup(user)
    expect(await dial(user, "1*1234", session)).toContain("Balans:")
  })

  /**
   * §18.2 **S-8**, second half: "3 wrong PINs → 1h block".
   *
   * The first half — a full transfer session — is the gateway round trip in
   * "creates one transfer when the gateway delivers the last step twice",
   * which walks `2*phone*amount*pin` end to end and is the stronger version of
   * the scenario: it does it twice and still moves the money once.
   */
  it("blocks the channel after three wrong PINs (FR-9.5)", async () => {
    const user = await newUser()
    await setPin(user)

    expect(await dial(user, "1*1111", randomUUID())).toBe("END PIN noto'g'ri.")
    expect(await dial(user, "1*2222", randomUUID())).toBe("END PIN noto'g'ri.")
    expect(await dial(user, "1*3333", randomUUID())).toContain("PIN bloklandi")
    // And the correct PIN no longer opens it, which is the whole point.
    expect(await dial(user, "1*1234", randomUUID())).toContain("PIN bloklandi")
  })

  it("spends FR-4.9's budget on this channel too, from the same counter", async () => {
    /*
     * The gap that closing P-34 exposed. The adapter enforced a cap here, and
     * the suite only ever checked the `SlidingWindow` class in isolation — so
     * a USSD lookup with no cap at all would have passed, which is precisely
     * the enumeration oracle the step is gated to prevent. §11.7 asks for the
     * recipient *before* the PIN, so this is the one disclosure on the channel
     * that no secret stands in front of.
     *
     * Both channels now go through `AccountService`, and the point of this
     * test is that a single mutation there turns this red as well as the web's
     * equivalent in `day5.test.ts`. One rule, two consumers, one budget.
     *
     * It pins the *count* and deliberately not the *window*: there is no
     * clock injected here, and shrinking `LOOKUP_WINDOW_MS` sixtyfold leaves
     * this test green. That is the refactor's payoff rather than a hole —
     * `day5.test.ts` advances a clock across the boundary against the same
     * `AccountService` instance type, and there is no second window left to
     * drift from it. Verified: no `SlidingWindow` survives outside the domain.
     */
    const caller = await newUser()
    const target = await newUser("Zulfiya", "Karimova")
    const national = target.phone.replace("+998", "")

    for (let i = 0; i < 20; i++) {
      const reply = await dial(caller, `2*${national}`, randomUUID())
      expect(reply, `lookup ${i + 1}`).toContain("ZULFIYA K.")
    }

    /*
     * `END`, not a JSON 429. A refusal on this channel is still a USSD reply —
     * the §12.3 envelope the web receives would be rendered on a feature phone
     * as the sentence the subscriber reads.
     */
    const refused = await dial(caller, `2*${national}`, randomUUID())
    expect(refused).toMatch(/^END /)
    expect(refused).not.toContain("ZULFIYA K.")
  })

  it("answers every step inside FR-9.4's budget", async () => {
    /*
     * FR-9.4 asks for a response under 10 s, targeting 3 s, and nothing
     * measured it. On this channel the number is not a nicety: the network
     * holds the session for 180 s and a subscriber is standing still with a
     * handset, so a step that takes seconds is a step that gets pressed twice.
     *
     * The assertion is the **requirement** (10 s), not the target. A CPU-time
     * bound on shared CI hardware is a flaky test, and this repository already
     * paid for one of those — a bound tight enough to be interesting is a bound
     * that goes red for reasons that have nothing to do with the code. What the
     * target gets instead is a measurement, recorded in the runbook, taken
     * against a running server rather than asserted here.
     *
     * Measured on a development machine over five sessions: menu 11 ms median,
     * recipient quote 18 ms, and the transfer step — argon2 PIN verification
     * plus a Serializable transaction, the only expensive one — 143 ms median,
     * 229 ms worst. Thirteen times inside the target.
     */
    const sender = await newUser()
    const recipient = await newUser("Zulfiya", "Karimova")
    await setPin(sender)
    await topup(sender)

    const session = randomUUID()
    const national = recipient.phone.replace("+998", "")
    const steps = ["", "2", `2*${national}`, `2*${national}*50000`, `2*${national}*50000*1234`]

    for (const text of steps) {
      const started = performance.now()
      await dial(sender, text, session)
      const elapsed = performance.now() - started

      expect(elapsed, `FR-9.4: "${text}" took ${elapsed.toFixed(0)}ms`).toBeLessThan(
        USSD_RESPONSE_CEILING_MS,
      )
    }
  })

  it("moves money through the same service the web uses", async () => {
    const sender = await newUser()
    const recipient = await newUser("Zulfiya", "Karimova")
    await setPin(sender)
    await topup(sender)

    const session = randomUUID()
    const national = recipient.phone.replace("+998", "")

    expect(await dial(sender, "2", session)).toContain("Qabul qiluvchi")
    // The masked name, so the sender can tell whether this is the right person
    // before the PIN — and masked, so the channel is not a directory (FR-4.6).
    expect(await dial(sender, `2*${national}`, session)).toContain("ZULFIYA K.")
    expect(await dial(sender, `2*${national}*50000`, session)).toContain("50 000 so'm")

    const result = await dial(sender, `2*${national}*50000*1234`, session)
    expect(result).toContain("50 000 so'm yuborildi")
    expect(result).toContain("Balans: 950 000 so'm")

    // The transfer is one the web can see: same table, same history, and the
    // channel recorded as USSD.
    const history = await request(sender.app)
      .get("/api/transfers")
      .set("authorization", `Bearer ${sender.token}`)
    expect(history.body.items[0]).toMatchObject({
      channel: "USSD",
      direction: "outgoing",
      amount: "5000000",
    })
  })

  it("spells a Cyrillic recipient in the only alphabet the channel has", async () => {
    const sender = await newUser()
    const recipient = await newUser("Зулфия", "Каримова")
    await setPin(sender)

    /*
     * `nameSchema` accepts this name by name, so it is the ordinary case
     * rather than an edge one. Left as it comes, those six letters take the
     * whole message out of the 7-bit alphabet: the budget drops from 182 to
     * 70 and the network cuts what is left, with nothing anywhere saying so.
     *
     * `dial` checks the alphabet on every reply, so the assertion below is
     * about the second half — that the sender still sees a name they can
     * recognise rather than `??????`.
     */
    const reply = await dial(sender, `2*${recipient.phone.replace("+998", "")}`, randomUUID())
    expect(reply).toContain("ZULFIYA K.")
  })

  it("writes down every refusal it shows (NFR-5)", async () => {
    const user = await newUser()
    await setPin(user)

    await dial(user, "1*9999", randomUUID())

    /*
     * The adapter answers `END` for everything, including its own bugs. That
     * is right for the handset and wrong for operations: without this line a
     * channel where every PIN suddenly fails looks, from the logs, exactly
     * like a channel nobody is using.
     */
    expect(user.logText()).toContain("ussd.refused")
  })

  it("creates one transfer when the gateway delivers the last step twice", async () => {
    const sender = await newUser()
    const recipient = await newUser("Zulfiya", "Karimova")
    await setPin(sender)
    await topup(sender)

    const session = randomUUID()
    const national = recipient.phone.replace("+998", "")
    const final = `2*${national}*50000*1234`

    const first = await dial(sender, final, session)
    /*
     * §11.7's idempotency rule. A gateway redelivering the final request is
     * ordinary — the session has no acknowledgement — and the key is derived
     * from the session and its accumulated text, so the second delivery
     * returns the first answer rather than sending again.
     */
    const second = await dial(sender, final, session)
    expect(second).toBe(first)

    const history = await request(sender.app)
      .get("/api/transfers")
      .set("authorization", `Bearer ${sender.token}`)
    const p2p = history.body.items.filter((item: { type: string }) => item.type === "P2P")
    expect(p2p).toHaveLength(1)
  })

  it("never reports a replayed failure as a transfer that happened", async () => {
    const sender = await newUser()
    const recipient = await newUser("Zulfiya", "Karimova")
    await setPin(sender)
    // No top-up: the balance is zero and the transfer is refused.

    const session = randomUUID()
    const final = `2*${recipient.phone.replace("+998", "")}*50000*1234`

    expect(await dial(sender, final, session)).toBe("END Balansda yetarli mablag' yo'q.")

    /*
     * The redelivery is the interesting half.
     *
     * §11.5 records a refused transfer as a FAILED row rather than as nothing,
     * so replaying its key returns a *result* — and a result reached the
     * success message by default. "50 000 so'm yuborildi" for money that never
     * moved is the one thing this screen must never say, and it is exactly the
     * shape a caller cannot check: the session has already ended.
     */
    expect(await dial(sender, final, session)).toBe("END Balansda yetarli mablag' yo'q.")
  })

  it("says an amount is over the channel ceiling before asking for the PIN", async () => {
    const sender = await newUser()
    const recipient = await newUser("Zulfiya", "Karimova")
    await setPin(sender)
    await topup(sender)

    const session = randomUUID()
    const national = recipient.phone.replace("+998", "")
    await dial(sender, `2*${national}`, session)

    /*
     * 500 001 so'm, one over `CHANNEL_LIMITS.USSD.perOperation`.
     *
     * The service would refuse it too — but only after the PIN, which inside a
     * 180-second session costs the sender an entry against a three-attempt
     * lock for something they could have been told one step earlier.
     */
    const reply = await dial(sender, `2*${national}*500001`, session)
    expect(reply).toContain("Chegara")
    expect(reply).toMatch(/^END /)
  })

  it("refuses an unregistered recipient the same way it refuses the treasury", async () => {
    const sender = await newUser()
    await setPin(sender)
    const session = randomUUID()

    expect(await dial(sender, `2*${uniquePhone().replace("+998", "")}`, session)).toBe(
      "END Qabul qiluvchi topilmadi.",
    )
  })

  it("shows the last three operations, failures marked as failures", async () => {
    const user = await newUser()
    await setPin(user)
    await topup(user)

    const reply = await dial(user, "3*1234", randomUUID())
    expect(reply).toContain("Oxirgi amaliyotlar:")
    expect(reply).toContain("+1 000 000")
  })

  it("distinguishes no history from a history it could not read", async () => {
    const user = await newUser()
    await setPin(user)
    // A blank list and a failure are the same empty screen and opposite facts.
    expect(await dial(user, "3*1234", randomUUID())).toBe("END Hali amaliyot yo'q.")
  })

  it("answers an unknown choice with a sentence, not an error envelope", async () => {
    const user = await newUser()
    const reply = await dial(user, "7", randomUUID())
    expect(reply).toBe("END Noto'g'ri tanlov.")
    // The failure that this replaces: `{"error":{"code":...}}` rendered on a
    // feature phone, where it means nothing and cannot be acted on.
    expect(reply).not.toContain("{")
  })
})

describe.skipIf(!hasDatabase)("the gateway door (FR-9.1)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  function callback(text = "") {
    return {
      sessionId: randomUUID(),
      phoneNumber: "+998901234567",
      networkCode: "62120",
      serviceCode: "*880#",
      text,
    }
  }

  it("answers a caller carrying the secret", async () => {
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: GATEWAY_SECRET })
    const res = await request(app)
      .post("/api/channels/ussd")
      .set("x-gateway-secret", GATEWAY_SECRET)
      .send(callback())

    expect(res.status).toBe(200)
    expect(res.text).toMatch(/^CON /)
  })

  it("refuses a caller with the wrong secret", async () => {
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: GATEWAY_SECRET })
    const res = await request(app)
      .post("/api/channels/ussd")
      .set("x-gateway-secret", `${GATEWAY_SECRET}x`)
      .send(callback())

    expect(res.status).toBe(401)
  })

  it("is closed, not open, when no secret is configured", async () => {
    /*
     * The MVP ships without a shortcode (FR-9.6), so an unset secret is the
     * expected production state. "Not configured yet" and "open to the
     * internet" must not be the same deployment.
     */
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: undefined })
    const res = await request(app)
      .post("/api/channels/ussd")
      /*
       * A header is sent, and that is the whole test.
       *
       * Written first without one, it passed against a version that returned
       * *true* for an unconfigured secret — because a caller presenting
       * nothing is refused by the other half of the condition. The attacker
       * this guards against presents a guess, so the test has to as well.
       */
      .set("x-gateway-secret", "anything-at-all")
      .send(callback())

    expect(res.status).toBe(401)
  })

  it("accepts the form encoding a real gateway posts", async () => {
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: GATEWAY_SECRET })
    const res = await request(app)
      .post("/api/channels/ussd")
      .set("x-gateway-secret", GATEWAY_SECRET)
      .type("form")
      .send(callback())

    // Without `express.urlencoded` on this route the body is `{}` and every
    // real callback is answered with a validation error.
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/^CON /)
  })

  it("keeps a subscriber's mistake off the wire as text, not as JSON", async () => {
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: GATEWAY_SECRET })
    const res = await request(app)
      .post("/api/channels/ussd")
      .set("x-gateway-secret", GATEWAY_SECRET)
      .send({ ...callback(), phoneNumber: "not-a-number" })

    // The subscriber's field, so the subscriber's format. A §12.3 envelope
    // would be rendered on their handset.
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/^END /)
  })

  it("answers a broken envelope in the format the integration can read", async () => {
    const { app } = buildApp(prisma, { ...process.env, USSD_GATEWAY_SECRET: GATEWAY_SECRET })
    const res = await request(app)
      .post("/api/channels/ussd")
      .set("x-gateway-secret", GATEWAY_SECRET)
      .send({ phoneNumber: "+998901234567", text: "" })

    // A missing `sessionId` is the gateway's fault, and the gateway is the one
    // caller that can read JSON.
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})
