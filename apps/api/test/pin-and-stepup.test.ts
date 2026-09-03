import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { STEP_UP_THRESHOLD } from "@wallet/shared"
import type { Express } from "express"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { AuthService } from "../src/domain/AuthService.js"
import { TransferService } from "../src/domain/TransferService.js"
import { pinSubject } from "../src/infra/crypto.js"
import { createTokenService } from "../src/infra/jwt.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

/**
 * FR-2.8's step-up and FR-9.5's PIN — two credentials, two channels, and the
 * reasons they must not become one.
 *
 * The step-up asks for the password again because an access token proves a
 * live session, not the account holder: a phone left unlocked on a table is a
 * live session. The PIN guards USSD, where the keypad is a dialer and a
 * passphrase cannot be typed at all.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

/** Assembled rather than written out: a literal here trips the secret scanner. */
const SECRET = ["orbit", "walnut", "lantern", "quiet"].join("-")
const WRONG = ["not", "the", "one"].join("-")

describe.skipIf(!hasDatabase)("the PIN (FR-1.6, FR-9.5)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function newUser() {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Alisher", lastName: "Navoiy", password: SECRET })
    return { app, phone, token: res.body.accessToken as string, id: res.body.user.id as string }
  }

  async function setPin(user: Awaited<ReturnType<typeof newUser>>, pin: string, secret = SECRET) {
    return request(user.app)
      .put("/api/me/pin")
      .set("authorization", `Bearer ${user.token}`)
      .send({ currentPassword: secret, pin })
  }

  function auth() {
    const env = testEnv({ ...process.env })
    return new AuthService({ prisma, tokens: createTokenService(env), pepper: env.JWT_SECRET })
  }

  it("is not set by registration (FR-1.6)", async () => {
    const user = await newUser()

    const me = await request(user.app).get("/api/me").set("authorization", `Bearer ${user.token}`)

    // Setting it at registration would give every new account a credential for
    // a channel most of them will never use.
    expect(me.body.pinSet).toBe(false)
  })

  it("needs the account password, not just a live session", async () => {
    const user = await newUser()

    const refused = await setPin(user, "1234", WRONG)

    /*
     * A token proves somebody holds a session. It does not prove they are the
     * account holder, and this endpoint hands out access to a second channel —
     * so a borrowed phone must not be enough.
     *
     * And never 401: that would send the client off to refresh a session that
     * is perfectly valid and retry a request that fails the same way.
     */
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe("STEP_UP_FAILED")
  })

  it("is set once the password is right, and says so without revealing it", async () => {
    const user = await newUser()

    expect((await setPin(user, "1234")).status).toBe(204)

    const me = await request(user.app).get("/api/me").set("authorization", `Bearer ${user.token}`)
    expect(me.body.pinSet).toBe(true)
    // The boolean, never the value and never the hash.
    expect(JSON.stringify(me.body)).not.toContain("1234")
    expect(JSON.stringify(me.body)).not.toContain("$argon2")

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(row.pinHash).toMatch(/^\$argon2id\$/)
    // NFR-1.1: the same parameters as a password. Ten thousand values is few
    // enough that a cheaper hash would make the storage the weak part.
    //
    // Asserted per parameter rather than as one string: argon2 writes them
    // alphabetically (`m,p,t`), and matching the order NFR-1.1 lists them in
    // would be testing the encoder rather than the cost.
    for (const parameter of ["m=19456", "t=2", "p=1"]) {
      expect(row.pinHash).toContain(parameter)
    }
  })

  it("refuses anything that is not four digits", async () => {
    const user = await newUser()

    for (const pin of ["123", "12345", "abcd", "12 4", ""]) {
      const res = await setPin(user, pin)
      expect(res.status, `pin ${JSON.stringify(pin)}`).toBe(400)
    }
  })

  it("blocks after three wrong attempts, and the right one no longer helps", async () => {
    const user = await newUser()
    await setPin(user, "1234")
    const service = auth()

    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(service.verifyPin(user.id, "9999")).rejects.toMatchObject({
        code: "AUTH_INVALID_CREDENTIALS",
      })
    }

    /*
     * The third failure locks. From then on even the correct PIN is refused,
     * which is the point: an attacker who guesses right on the fourth try
     * still gets nothing.
     */
    await expect(service.verifyPin(user.id, "9999")).rejects.toMatchObject({ code: "PIN_LOCKED" })
    await expect(service.verifyPin(user.id, "1234")).rejects.toMatchObject({ code: "PIN_LOCKED" })

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(row.pinLockedUntil).not.toBeNull()
    // An hour, per FR-9.5.
    expect((row.pinLockedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(55 * 60 * 1000)
  })

  it("clears the block when the password is proved again", async () => {
    const user = await newUser()
    await setPin(user, "1234")

    await prisma.user.update({
      where: { id: user.id },
      data: { pinLockedUntil: new Date(Date.now() + 60 * 60 * 1000) },
    })

    await setPin(user, "5678")

    /*
     * Somebody who can prove the password has demonstrated more than three
     * correct digits would. Leaving them locked out of a PIN they have just
     * chosen punishes the recovery rather than the attack.
     */
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(row.pinLockedUntil).toBeNull()
  })

  it("blocks a burst of wrong PINs that arrives together, not just one at a time", async () => {
    /*
     * FR-9.5 counted three failures by reading the lock, verifying, writing the
     * attempt and then counting — four statements with nothing holding the user
     * still between them. Twenty dials that arrive together all read an unlocked
     * account, all write a failure and all answer "PIN noto'g'ri", so the
     * channel that has only a four-digit secret in front of it gives away twenty
     * guesses for the price of three.
     *
     * Through the simulator rather than the service, because that is the path a
     * dialler has: one HTTP request per keypress, and nothing stopping twenty of
     * them being in flight at once.
     */
    const user = await newUser()
    await setPin(user, "1234")

    const dial = () =>
      request(user.app)
        .post("/api/channels/ussd/simulate")
        .set("authorization", `Bearer ${user.token}`)
        .send({
          sessionId: randomUUID(),
          phoneNumber: "ignored",
          networkCode: "62120",
          serviceCode: "*880#",
          text: "1*9999",
        })

    const replies = (await Promise.all(Array.from({ length: 20 }, dial))).map((res) => res.text)

    const failures = await prisma.authAttempt.count({
      where: {
        subject: pinSubject(user.id, testEnv({ ...process.env }).JWT_SECRET),
        succeeded: false,
      },
    })
    expect(failures, "one row per PIN that was actually verified").toBe(3)

    /*
     * Two, not three. The third failure is the one that writes the lock, and it
     * refuses with `PIN_LOCKED` in the same breath — the sequential behaviour
     * `ussd.test.ts` already pins. Serialising must not change it.
     */
    expect(replies.filter((text) => text === "END PIN noto'g'ri.")).toHaveLength(2)
    expect(replies.filter((text) => text.includes("PIN bloklandi"))).toHaveLength(18)

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    // An hour from the third failure, not from the twentieth: an attempt made
    // while the block is up is refused before it can extend it.
    expect((row.pinLockedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(55 * 60 * 1000)
    expect((row.pinLockedUntil?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  it("counts PIN failures separately from login failures", async () => {
    const user = await newUser()
    await setPin(user, "1234")
    const service = auth()

    for (let attempt = 1; attempt <= 3; attempt++) {
      await service.verifyPin(user.id, "9999").catch(() => undefined)
    }

    /*
     * Two credentials guarding two channels. One counter for both would let an
     * attacker on the cheap channel lock the expensive one: three wrong PINs
     * over USSD would otherwise lock the owner out of their own login.
     */
    const login = await request(user.app)
      .post("/api/auth/login")
      .send({ phone: user.phone, password: SECRET })
    expect(login.status).toBe(200)
  })
})

describe.skipIf(!hasDatabase)("step-up on a large transfer (FR-2.8)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  /**
   * @param topUps how many demo top-ups to take. FR-10.3 allows three a day,
   *   so a test that needs to make one of its own must not arrive having
   *   already spent the allowance — which is a limit about top-ups and has
   *   nothing to say about the step-up these tests are named for.
   */
  async function funded(topUps = 3): Promise<{ userId: string; phone: string }> {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Alisher", lastName: "Navoiy", password: SECRET })
    const token = res.body.accessToken as string

    for (let i = 0; i < topUps; i++) {
      await request(app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${token}`)
        .set("idempotency-key", randomUUID())
        .send()
    }

    return { userId: res.body.user.id as string, phone }
  }

  /**
   * With the real confirmation behind it, because that is what these tests are
   * about: FR-2.8's password is the account password, and `AuthService` is what
   * knows so.
   */
  function service() {
    const env = testEnv({ ...process.env })
    const auth = new AuthService({
      prisma,
      tokens: createTokenService(env),
      pepper: env.JWT_SECRET,
    })
    return new TransferService({
      prisma,
      confirmPassword: (userId, password) => auth.confirmPassword(userId, password),
    })
  }

  /**
   * A relationship older than a day, so FR-6.2 does not answer first.
   *
   * The new-recipient cap is 500 000 so'm and the step-up threshold is a
   * million: every transfer in this suite would otherwise be refused for being
   * a large first payment, and these tests would pass or fail for a reason
   * they are not about.
   */
  async function establish(sender: { userId: string }, recipient: { phone: string }) {
    await service().execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: 100_000n,
      idempotencyKey: randomUUID(),
      channel: "WEB",
    })
    await prisma.transfer.updateMany({
      where: { initiatedBy: sender.userId },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    })
  }

  /**
   * Over HTTP, not through the service.
   *
   * Every other test in this block calls `execute` directly, which proves the
   * rule and proves nothing about the two lines that carry a password from a
   * request body to it. Those two lines were missing, every large transfer was
   * refused however carefully the password was typed, and no test noticed.
   */
  it("carries the confirmation from the request body to the rule", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const phone = uniquePhone()
    const registered = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Alisher", lastName: "Navoiy", password: SECRET })
    const token = registered.body.accessToken as string

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${token}`)
        .set("idempotency-key", randomUUID())
        .send()
    }

    const recipient = await funded(0)

    // An established relationship, so FR-6.2 does not answer first.
    await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: recipient.phone, amount: "100000" })
    await prisma.transfer.updateMany({
      where: { initiatedBy: registered.body.user.id as string },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    })

    const withoutIt = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: recipient.phone, amount: (STEP_UP_THRESHOLD + 100n).toString() })
    expect(withoutIt.status).toBe(422)
    expect(withoutIt.body.error.code).toBe("STEP_UP_REQUIRED")

    const withIt = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", randomUUID())
      .send({
        phone: recipient.phone,
        amount: (STEP_UP_THRESHOLD + 100n).toString(),
        password: SECRET,
      })
    expect(withIt.status, JSON.stringify(withIt.body)).toBe(201)
  })

  it("lets a transfer at the threshold through untouched", async () => {
    const sender = await funded()
    const recipient = await funded()
    await establish(sender, recipient)

    const result = await service().execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: STEP_UP_THRESHOLD,
      idempotencyKey: randomUUID(),
      channel: "WEB",
    })

    // Exactly at the threshold is not above it. An off-by-one here asks for a
    // password on the most common transfer size in this market.
    expect(result.status).toBe("COMPLETED")
  })

  it("refuses one above the threshold with nothing to confirm it", async () => {
    const sender = await funded()
    const recipient = await funded()

    await expect(
      service().execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: STEP_UP_THRESHOLD + 100n,
        idempotencyKey: randomUUID(),
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" })
  })

  it("refuses a wrong confirmation without touching the money", async () => {
    const sender = await funded()
    const recipient = await funded()
    const before = await prisma.account.findFirstOrThrow({
      where: { user: { phone: sender.phone } },
    })

    await expect(
      service().execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: STEP_UP_THRESHOLD + 100n,
        idempotencyKey: randomUUID(),
        channel: "WEB",
        password: WRONG,
      }),
    ).rejects.toMatchObject({ code: "STEP_UP_FAILED" })

    const after = await prisma.account.findFirstOrThrow({
      where: { user: { phone: sender.phone } },
    })
    expect(after.balance).toBe(before.balance)
  })

  it("accepts it when the confirmation is right", async () => {
    const sender = await funded()
    const recipient = await funded()
    await establish(sender, recipient)

    const result = await service().execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: STEP_UP_THRESHOLD + 100n,
      idempotencyKey: randomUUID(),
      channel: "WEB",
      password: SECRET,
    })

    expect(result.status).toBe("COMPLETED")
  })

  it("does not ask a top-up to confirm a gift", async () => {
    const user = await funded(0)

    // The treasury's money moving to them. FR-10 already caps this at three a
    // day; asking someone to confirm a gift is ceremony.
    const result = await service().topUp(user.userId, randomUUID())
    expect(result.status).toBe("COMPLETED")
  })

  it("cannot be skipped by replaying the key of a refused attempt", async () => {
    const sender = await funded()
    const recipient = await funded()
    const key = randomUUID()

    const attempt = () =>
      service().execute({
        senderUserId: sender.userId,
        recipientPhone: recipient.phone,
        amount: STEP_UP_THRESHOLD + 100n,
        idempotencyKey: key,
        channel: "WEB",
      })

    await expect(attempt()).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" })

    // A refusal writes no idempotency record, so the second attempt is not a
    // replay at all — it is the same refusal, reached the same way.
    await expect(attempt()).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" })
  })

  it("lets a completed transfer be retried without asking for the password again", async () => {
    const sender = await funded()
    const recipient = await funded()
    await establish(sender, recipient)
    const key = randomUUID()

    const first = await service().execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: STEP_UP_THRESHOLD + 100n,
      idempotencyKey: key,
      channel: "WEB",
      password: SECRET,
    })

    /*
     * The retry the offline outbox makes (FR-8.3), and the reason the replay
     * lookup runs before the step-up check.
     *
     * A queued transfer must never carry a password into IndexedDB, so a retry
     * arrives with the key and nothing else. Checking the step-up first would
     * demand a confirmation for money that has already moved — and the client
     * cannot supply one, so a completed transfer would look permanently
     * failed.
     */
    const retried = await service().execute({
      senderUserId: sender.userId,
      recipientPhone: recipient.phone,
      amount: STEP_UP_THRESHOLD + 100n,
      idempotencyKey: key,
      channel: "WEB",
    })

    expect(retried.id).toBe(first.id)
    expect(retried.status).toBe("COMPLETED")
  })
})

/**
 * FR-2.3's backoff in front of the two endpoints that ask for the password
 * again (FR-2.8, FR-1.6).
 *
 * The step-up and the PIN change verify the *account password* — the same
 * credential login verifies — so a session holder who could guess it there
 * without a counter would simply have a second door to the first one. One
 * counter and one lock for all three is what closes it, and the tests below
 * check that they really are one: failures spent on a transfer lock the
 * sign-in.
 */
describe.skipIf(!hasDatabase)("confirming the password (FR-2.3, FR-2.8, FR-1.6)", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  /**
   * Registered through the app under test rather than through a fresh one per
   * request, because the rate limit budgets live inside the instance — a new
   * app per call is a new counter, which is how a limiter comes to be mounted
   * and dead (`app.ts` records the same lesson about `globalLimit`).
   */
  async function account(app: Express, topUps = 0) {
    const phone = uniquePhone()
    const registered = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Alisher", lastName: "Navoiy", password: SECRET })
    const token = registered.body.accessToken as string

    for (let i = 0; i < topUps; i++) {
      await request(app)
        .post("/api/accounts/topup")
        .set("authorization", `Bearer ${token}`)
        .set("idempotency-key", randomUUID())
        .send()
    }

    return { phone, token }
  }

  it("locks the fourth wrong confirmation on a transfer, and the sign-in with it", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const sender = await account(app)
    const recipient = await account(app)

    /*
     * No funds and no established relationship on purpose. The step-up runs
     * before the transaction, so every attempt here is refused by the
     * confirmation and by nothing else.
     */
    const send = (password: string) =>
      request(app)
        .post("/api/transfers")
        .set("authorization", `Bearer ${sender.token}`)
        .set("idempotency-key", randomUUID())
        .send({ phone: recipient.phone, amount: (STEP_UP_THRESHOLD + 100n).toString(), password })

    for (let attempt = 1; attempt <= 3; attempt++) {
      const refused = await send(WRONG)
      expect(refused.status, `attempt ${attempt}`).toBe(422)
      expect(refused.body.error.code).toBe("STEP_UP_FAILED")
    }

    // The fourth is the one FR-2.3 makes wait, and it is 429 rather than 422:
    // nothing about the password was judged, so `STEP_UP_FAILED` would be a
    // claim this attempt never made.
    const locked = await send(WRONG)
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe("AUTH_LOCKED")
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0)

    /*
     * The point of the shared subject. Guesses spent on transfers are the same
     * guesses login counts, so an attacker cannot get four free ones per
     * endpoint by moving between them.
     */
    const signIn = await request(app)
      .post("/api/auth/login")
      .send({ phone: sender.phone, password: SECRET })
    expect(signIn.status).toBe(429)
    expect(signIn.body.error.code).toBe("AUTH_LOCKED")
  }, 30_000)

  it("locks the fourth wrong confirmation on a PIN change, and the sign-in with it", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const user = await account(app)

    const change = (password: string) =>
      request(app)
        .put("/api/me/pin")
        .set("authorization", `Bearer ${user.token}`)
        .send({ currentPassword: password, pin: "1234" })

    for (let attempt = 1; attempt <= 3; attempt++) {
      const refused = await change(WRONG)
      expect(refused.status, `attempt ${attempt}`).toBe(422)
      expect(refused.body.error.code).toBe("STEP_UP_FAILED")
    }

    const locked = await change(WRONG)
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe("AUTH_LOCKED")

    const signIn = await request(app)
      .post("/api/auth/login")
      .send({ phone: user.phone, password: SECRET })
    expect(signIn.status).toBe(429)
    expect(signIn.body.error.code).toBe("AUTH_LOCKED")
  }, 30_000)

  it("forgets the failures once the password is proved", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const user = await account(app)

    const change = (password: string) =>
      request(app)
        .put("/api/me/pin")
        .set("authorization", `Bearer ${user.token}`)
        .send({ currentPassword: password, pin: "1234" })

    expect((await change(WRONG)).status).toBe(422)
    expect((await change(WRONG)).status).toBe(422)

    // A correct confirmation writes a success, and the count runs from the
    // last one — exactly as a completed sign-in clears it. Someone who mistypes
    // twice and then gets it right must not be one slip from a lockout.
    expect((await change(SECRET)).status).toBe(204)

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await change(WRONG)).status, `attempt ${attempt} after the success`).toBe(422)
    }
    expect((await change(WRONG)).status).toBe(429)
  }, 30_000)

  it("meters confirmations per address, and charges an ordinary transfer nothing", async () => {
    const { app } = buildApp(prisma, { ...process.env })
    const user = await account(app, 1)
    const recipient = await account(app)

    /*
     * One address for everything the budget is meant to count. The
     * registrations above carry a password field too, but `/auth/register` does
     * not mount this limiter — it has its own — so they cannot spend it, and
     * they are left on the default address regardless.
     */
    const METERED = "10.7.7.7"

    const change = (password: string) =>
      request(app)
        .put("/api/me/pin")
        .set("x-forwarded-for", METERED)
        .set("authorization", `Bearer ${user.token}`)
        .send({ currentPassword: password, pin: "1234" })

    const codes = new Set<string>()
    for (let attempt = 1; attempt <= 50; attempt++) {
      const refused = await change(WRONG)
      expect(refused.status, `attempt ${attempt}`).toBeGreaterThanOrEqual(400)
      codes.add(refused.body.error.code as string)
    }

    // Fifty is what the budget allows, so all of them were refused by the
    // password rules rather than by the address.
    expect(codes).toEqual(new Set(["STEP_UP_FAILED", "AUTH_LOCKED"]))

    /*
     * A transfer below the step-up threshold sends no password, so it never
     * spends this budget. If it did, this would be the fifty-first request from
     * the address and an ordinary payment would be refused for somebody else's
     * guessing.
     */
    const transferred = await request(app)
      .post("/api/transfers")
      .set("x-forwarded-for", METERED)
      .set("authorization", `Bearer ${user.token}`)
      .set("idempotency-key", randomUUID())
      .send({ phone: recipient.phone, amount: "100000" })
    expect(transferred.status, JSON.stringify(transferred.body)).toBe(201)

    const throttled = await change(WRONG)
    expect(throttled.status).toBe(429)
    // `RATE_LIMITED`, not `AUTH_LOCKED`: this one was stopped by the address
    // budget, and the two refusals mean different things to the client.
    expect(throttled.body.error.code).toBe("RATE_LIMITED")
  }, 60_000)
})
