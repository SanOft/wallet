import type { PrismaClient } from "@prisma/client"
import type { Rate } from "@wallet/shared"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { seed } from "../prisma/seed.js"
import { memoryRatesStore, RatesService } from "../src/domain/RatesService.js"
import { fetchCbuRates } from "../src/infra/cbu.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { RatesRepository } from "../src/infra/RatesRepository.js"
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
    const rates = new RatesService({ fetcher, store: memoryRatesStore(), now: () => clock })

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
    const rates = new RatesService({ fetcher, store: memoryRatesStore(), now: () => clock })

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
    const rates = new RatesService({ fetcher, store: memoryRatesStore(), now: () => clock })

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
    const rates = new RatesService({
      fetcher: () => Promise.reject(new Error("down")),
      store: memoryRatesStore(),
    })

    await expect(rates.current()).rejects.toMatchObject({ code: "RATES_UNAVAILABLE" })
  })

  it("recovers on its own once the upstream returns", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([USD])
    const rates = new RatesService({ fetcher, store: memoryRatesStore() })

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
    const rates = new RatesService({ fetcher, store: memoryRatesStore() })

    const callers = Array.from({ length: 10 }, () => rates.current())
    release([USD])
    const answers = await Promise.all(callers)

    // Ten sockets to a struggling upstream, opened at precisely the moment it
    // is struggling, is how a slow dependency becomes an outage.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(answers.every((answer) => answer.rates[0]?.rate === USD.rate)).toBe(true)
  })
})

describe("surviving a restart (P-30)", () => {
  it("serves the previous process's reading when it wakes to a silent upstream", async () => {
    const store = memoryRatesStore()
    const before = new RatesService({
      fetcher: () => Promise.resolve([USD]),
      store,
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    })
    await before.current()

    // A different instance, with nothing in memory — a cold start, which P-27
    // makes routine rather than rare on the free tier.
    const after = new RatesService({
      fetcher: () => Promise.reject(new Error("cbu.uz unreachable")),
      store,
      now: () => new Date("2026-08-28T14:00:00.000Z"),
    })
    const served = await after.current()

    // Before P-30 this was a 503: the promise FR-7.2 makes was kept only for a
    // process that had been running.
    expect(served.rates).toEqual([USD])
    expect(served.stale).toBe(true)
    expect(served.fetchedAt).toEqual(new Date("2026-08-28T10:00:00.000Z"))
  })

  it("uses a stored reading that is still inside the hour without asking again", async () => {
    const store = memoryRatesStore()
    await store.write({
      rates: [USD],
      fetchedAt: new Date("2026-08-28T10:00:00.000Z"),
      stale: false,
    })
    const fetcher = vi.fn()

    const service = new RatesService({
      fetcher,
      store,
      now: () => new Date("2026-08-28T10:30:00.000Z"),
    })
    const served = await service.current()

    // Two instances behind one load balancer should not each pay for their own
    // reading of a value that is published once a day.
    expect(fetcher).not.toHaveBeenCalled()
    expect(served.stale).toBe(false)
  })

  it("does not treat a reading stamped in the future as fresh", async () => {
    const store = memoryRatesStore()
    // A row written by an instance whose clock runs ahead. Two machines
    // disagreeing by seconds is ordinary; by an hour is a wrong timezone.
    await store.write({
      rates: [USD],
      fetchedAt: new Date("2026-08-29T10:00:00.000Z"),
      stale: false,
    })
    const fetcher = vi.fn().mockResolvedValue([LATER])

    const service = new RatesService({
      fetcher,
      store,
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    })
    const served = await service.current()

    /*
     * Without the check this is the permanent failure: `now - fetchedAt` is
     * negative, every comparison against the TTL passes, and the cache never
     * expires again for the life of that row. Observed in the browser — the
     * widget showed one rate for hours and nothing said why.
     */
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(served.rates).toEqual([LATER])
  })

  it("still falls back to a future-stamped reading when the upstream is down", async () => {
    const store = memoryRatesStore()
    await store.write({
      rates: [USD],
      fetchedAt: new Date("2026-08-29T10:00:00.000Z"),
      stale: false,
    })

    const service = new RatesService({
      fetcher: () => Promise.reject(new Error("down")),
      store,
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    })
    const served = await service.current()

    // Not trusted as current, but still better than nothing — which is the
    // whole distinction `stale` exists to carry.
    expect(served.rates).toEqual([USD])
    expect(served.stale).toBe(true)
  })

  it("treats a store it cannot read as an empty one", async () => {
    const store = {
      read: () => Promise.reject(new Error("database is down")),
      write: () => Promise.resolve(),
    }

    const service = new RatesService({ fetcher: () => Promise.resolve([USD]), store })
    const served = await service.current()

    // Refusing to serve rates because a cache is broken inverts what a cache
    // is for.
    expect(served.rates).toEqual([USD])
  })

  it("still answers when the store cannot be written", async () => {
    const store = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error("database is down")),
    }

    const service = new RatesService({ fetcher: () => Promise.resolve([USD]), store })

    // The value is already in hand and already correct; failing now would
    // discard a good answer over a bookkeeping error.
    await expect(service.current()).resolves.toMatchObject({ rates: [USD], stale: false })
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

  /*
   * The cache is durable now (P-30), which makes these tests share state
   * through the database unless each one says where it starts. The first
   * symptom was the contract test below reading a value a later test had
   * written — order-dependent, and green on its own.
   */
  beforeEach(async () => {
    await prisma.ratesSnapshot.deleteMany({})
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
    /*
     * Nothing stored (the `beforeEach`) and an upstream that refuses (the
     * default fetcher) — which after P-30 describes exactly one situation: a
     * fresh deployment whose database has never held a rate.
     */
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

  it("treats a stored payload it cannot recognise as no cache at all", async () => {
    const store = new RatesRepository(prisma)
    await store.write({
      rates: [USD],
      fetchedAt: new Date("2026-08-28T10:00:00.000Z"),
      stale: false,
    })

    // What a previous version of this code might have written, or what a
    // migration might leave behind. Our own old data is still data of unknown
    // shape.
    await prisma.ratesSnapshot.updateMany({ data: { payload: [{ currency: "USD" }] } })

    // A cache miss, not a 500 raised from `respond()` at the very edge of the
    // request after the work is already done.
    await expect(store.read()).resolves.toBeNull()
  })

  it("keeps exactly one row, and the database is what says so", async () => {
    const store = new RatesRepository(prisma)
    await store.write({
      rates: [USD],
      fetchedAt: new Date("2026-08-28T10:00:00.000Z"),
      stale: false,
    })
    await store.write({
      rates: [LATER],
      fetchedAt: new Date("2026-08-29T10:00:00.000Z"),
      stale: false,
    })

    expect(await prisma.ratesSnapshot.count()).toBe(1)

    // And a second row is refused by the CHECK rather than by this file
    // remembering to use one id.
    await expect(
      prisma.ratesSnapshot.create({
        data: { id: "SOMETHING_ELSE", payload: [], fetchedAt: new Date() },
      }),
    ).rejects.toThrow()
  })
})
