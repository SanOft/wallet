import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildApp } from "./helpers.js"

/**
 * `/health` is the one route anyone on the internet may call (§12.1), so what
 * it costs and what it says are both properties of the endpoint rather than
 * details of it. These run against a counting double instead of a database:
 * the number of queries a burst causes is the thing being asserted, and a real
 * client cannot be asked how many it ran.
 */
const APPLIED_MIGRATION = "20260829150000_ledger_balance_invariants"

function countingClient(): { readonly client: PrismaClient; readonly queries: () => number } {
  let queries = 0
  const client = {
    $queryRaw: async () => {
      queries += 1
      return [{ migration_name: APPLIED_MIGRATION }]
    },
  } as unknown as PrismaClient

  return { client, queries: () => queries }
}

function healthApp(client: PrismaClient) {
  return buildApp(client, { ...process.env, LOG_LEVEL: "fatal" }).app
}

describe("GET /health (runbook T-2.5)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not tell an unauthenticated caller which migration the database is on", async () => {
    const { client } = countingClient()

    const res = await request(healthApp(client)).get("/health")

    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty("migration")
    // Named in full as well as by key: the point is that the string never
    // reaches the wire, whichever field somebody puts it back under.
    expect(JSON.stringify(res.body)).not.toContain(APPLIED_MIGRATION)
  })

  it("answers a burst from a single database probe", async () => {
    const { client, queries } = countingClient()
    const app = healthApp(client)

    for (let call = 0; call < 5; call += 1) {
      const res = await request(app).get("/health")
      expect(res.status).toBe(200)
      expect(res.body.db).toBe("up")
    }

    expect(queries(), "five unauthenticated calls, one query").toBe(1)
  })

  it("probes again once the memo is older than five seconds", async () => {
    // Only `Date` is faked: supertest's request needs the real timers to
    // finish, and the memo reads the clock and nothing else.
    vi.useFakeTimers({ toFake: ["Date"] })
    const { client, queries } = countingClient()
    const app = healthApp(client)

    await request(app).get("/health")
    vi.setSystemTime(Date.now() + 5_001)
    await request(app).get("/health")

    expect(queries(), "a stale memo must not answer forever").toBe(2)
  })
})
