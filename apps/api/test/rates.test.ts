import type { PrismaClient } from "@prisma/client"
import type { Rate } from "@wallet/shared"
import request from "supertest"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { seed } from "../prisma/seed.js"
import { RatesService } from "../src/domain/RatesService.js"
import { fetchCbuRates } from "../src/infra/cbu.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv } from "./helpers.js"

/**
 * FR-7, and the degradation that is the only interesting part of it.
 *
 * Serving a cached rate is easy. Serving a cached rate while *saying so* is
 * the requirement, because a stale number renders exactly as authoritatively
 * as a fresh one — the user cannot tell them apart unless the API does.
 *
 * Nothing here reaches cbu.uz. A test that did would fail on a train, pass in
 * CI on a good day, and measure somebody else's uptime the rest of the time.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

const USD: Rate = {
  currency: "USD",
  rate: "11801.23",
  diff: "-22.46",
  nominal: "1",
  publishedOn: "2026-08-28",
}
const LATER: Rate = { ...USD, rate: "11900.00", publishedOn: "2026-08-29" }

describe("FR-7 — the rates cache, as a policy", () => {
  it("serves the upstream once and the cache after, inside the hour", async () => {
    const fetcher = vi.fn().mockResolvedValue([USD])
    let clock = new Date("2026-08-28T10:00:00.000Z")
    const rates = new RatesService({ fetcher, now: () => clock })

    await rates.current()
    clock = new Date("2026-08-28T10:59:00.000Z")
    const second = await rates.current()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(second.rates).toEqual([USD])
    // Fifty-nine minutes old and not stale: FR-7.2 sets the hour, and a rate
    // published once a day does not move inside it.
    expect(second.stale).toBe(false)
  })

  it("refreshes once the hour is up", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([USD]).mockResolvedValueOnce([LATER])
    let clock = new Date("2026-08-28T10:00:00.000Z")
    const rates = new RatesService({ fetcher, now: () => clock })

    await rates.current()
    clock = new Date("2026-08-28T11:00:01.000Z")
    const second = await rates.current()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(second.rates).toEqual([LATER])
    expect(second.stale).toBe(false)
  })

  it("keeps serving the last known value when the upstream goes silent, and says so", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([USD])
      .mockRejectedValue(new Error("cbu.uz unreachable"))
    let clock = new Date("2026-08-28T10:00:00.000Z")
    const rates = new RatesService({ fetcher, now: () => clock })

    const fresh = await rates.current()
    clock = new Date("2026-08-28T12:00:00.000Z")
    const degraded = await rates.current()

    expect(degraded.rates).toEqual([USD])
    // The whole requirement in one assertion. Without it the response is a
    // two-hour-old number presented as today's.
    expect(degraded.stale).toBe(true)
    // And the date the user is shown is the one the value was actually read
    // on, not the moment it was served.
    expect(degraded.fetchedAt).toEqual(fresh.fetchedAt)
  })

  it("refuses rather than inventing a rate when it has never held one", async () => {
    const rates = new RatesService({ fetcher: () => Promise.reject(new Error("down")) })

    await expect(rates.current()).rejects.toMatchObject({ code: "RATES_UNAVAILABLE" })
  })

  it("recovers on its own once the upstream returns", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([USD])
    const rates = new RatesService({ fetcher })

    await expect(rates.current()).rejects.toMatchObject({ code: "RATES_UNAVAILABLE" })
    const second = await rates.current()

    // A failure must not poison the cache into refusing forever, which is what
    // storing the error instead of leaving the slot empty would do.
    expect(second.rates).toEqual([USD])
    expect(second.stale).toBe(false)
  })

  it("asks the upstream once when ten callers arrive together", async () => {
    let release: (value: readonly Rate[]) => void = () => {}
    const pending = new Promise<readonly Rate[]>((resolve) => {
      release = resolve
    })
    const fetcher = vi.fn().mockReturnValue(pending)
    const rates = new RatesService({ fetcher })

    const callers = Array.from({ length: 10 }, () => rates.current())
    release([USD])
    const answers = await Promise.all(callers)

    // Ten sockets to a struggling upstream, opened at precisely the moment it
    // is struggling, is how a slow dependency becomes an outage.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(answers.every((answer) => answer.rates[0]?.rate === USD.rate)).toBe(true)
  })
})

describe("reading somebody else's JSON (FR-7.1)", () => {
  function feed(rows: unknown): void {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  }

  const upstream = (over: Record<string, unknown> = {}) => ({
    id: 68,
    Code: "840",
    Ccy: "USD",
    CcyNm_UZ: "AQSH dollari",
    Nominal: "1",
    Rate: "11801.23",
    Diff: "-22.46",
    Date: "28.08.2026",
    ...over,
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the two currencies FR-7.1 names and drops the rest", async () => {
    feed([upstream(), upstream({ Ccy: "EUR", Code: "978" }), upstream({ Ccy: "RUB", Code: "643" })])

    const rates = await fetchCbuRates()

    expect(rates.map((rate) => rate.currency)).toEqual(["USD", "EUR"])
  })

  it("normalises the published date to ISO", async () => {
    feed([upstream({ Date: "05.01.2026" })])

    const [rate] = await fetchCbuRates()

    // `05.01.2026` is the fifth of January. Reading it as the first of May is
    // a one-character mistake that is invisible for eleven days a month.
    expect(rate?.publishedOn).toBe("2026-01-05")
  })

  it("refuses a date it cannot read rather than guessing at it", async () => {
    feed([upstream({ Date: "2026-08-28" })])

    // The feed changing format is exactly when guessing produces a plausible
    // wrong answer, so this fails loudly and falls back to the cache.
    await expect(fetchCbuRates()).rejects.toThrow(/unreadable date/)
  })

  it("refuses a feed carrying neither currency", async () => {
    feed([upstream({ Ccy: "RUB", Code: "643" })])

    await expect(fetchCbuRates()).rejects.toThrow(/no rate/)
  })

  it("refuses a row missing the fields it needs", async () => {
    feed([{ Ccy: "USD", Rate: null, Diff: "-1", Nominal: "1", Date: "28.08.2026" }])

    // A `null` rate that survived to the client would render as the word
    // "null" where a price belongs.
    await expect(fetchCbuRates()).rejects.toThrow()
  })

  it("refuses a response that is not a success", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 502 })))

    await expect(fetchCbuRates()).rejects.toThrow(/502/)
  })
})

describe.skipIf(!hasDatabase)("FR-7 — over HTTP", () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = createPrismaClient(testEnv({ ...process.env }))
    await seed(prisma)
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function tokenFor(app: Parameters<typeof request>[0]) {
    const phone = `+99895${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
    const res = await request(app)
      .post("/api/auth/register")
      .send({ phone, firstName: "Muhammadali", lastName: "Toshmatov", password: PASSWORD })
    return res.body.accessToken as string
  }

  it("returns the contract §12.1 describes", async () => {
    const { app } = buildApp(prisma, { ...process.env }, undefined, () => Promise.resolve([USD]))
    const token = await tokenFor(app)

    const res = await request(app).get("/api/rates").set("authorization", `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.rates).toEqual([USD])
    expect(res.body.stale).toBe(false)
    expect(typeof res.body.fetchedAt).toBe("string")
  })

  it("answers 503 rather than 500 when there is nothing to serve", async () => {
    // The default fetcher refuses, which is what makes this the honest case.
    const { app } = buildApp(prisma, { ...process.env })
    const token = await tokenFor(app)

    const res = await request(app).get("/api/rates").set("authorization", `Bearer ${token}`)

    // 500 would tell the client we are broken and it should stop. 503 says an
    // upstream is down, the wallet works, try later — which is also what
    // `isRetryable` reads off the status.
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe("RATES_UNAVAILABLE")
  })

  it("requires a token", async () => {
    const { app } = buildApp(prisma, { ...process.env }, undefined, () => Promise.resolve([USD]))

    const res = await request(app).get("/api/rates")

    expect(res.status).toBe(401)
  })
})
