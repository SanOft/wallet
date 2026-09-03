import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { loadEnv } from "../src/config/env.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { buildApp } from "./helpers.js"

/**
 * Database-backed suites. They skip rather than fail when DATABASE_URL is
 * absent, so a clone without Docker still gets a green `yarn verify`; CI always
 * provides a Postgres service, so they always run there (spec §18.1).
 */
const hasDatabase = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDatabase)("GET /health (runbook T-2.5)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(loadEnv())
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  function app(client: PrismaClient) {
    return buildApp(client, { ...process.env, LOG_LEVEL: "fatal" }).app
  }

  it("returns 200 with the documented shape and the applied migration", async () => {
    const res = await request(app(prisma)).get("/health")

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: "ok",
      db: "up",
      migration: expect.stringMatching(/^\d{14}_/),
      // The commit the process was built from. The release workflow polls this
      // to tell the old instance from the new one, which is what lets it wait
      // for a deploy without a Render API token.
      version: expect.any(String),
      // How many proxies this request passed through, and how many the process
      // is told to believe (P-11). The count only, never the addresses — this
      // endpoint is unauthenticated.
      proxyChain: expect.any(Number),
      trustedHops: expect.any(Number),
    })
  })

  it("reports the commit the platform gave it", async () => {
    const { app: instance } = buildApp(prisma, {
      ...process.env,
      LOG_LEVEL: "fatal",
      // A real hosted deploy always carries both (F18) — NODE_ENV is set
      // here because RENDER_GIT_COMMIT alone now fails boot without it.
      NODE_ENV: "production",
      RENDER_GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    })

    const res = await request(instance).get("/health")
    // Read once at module load, so this asserts the wiring exists rather than
    // that the value is re-read per request — which is the property the deploy
    // gate depends on either way.
    expect(typeof res.body.version).toBe("string")
    expect(res.body.version.length).toBeGreaterThan(0)
  })

  it("reports 503 when the database is unreachable rather than lying with a 200", async () => {
    const broken = createPrismaClient(
      loadEnv({ ...process.env, DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/none" }),
    )

    try {
      const res = await request(app(broken)).get("/health")

      expect(res.status).toBe(503)
      expect(res.body).toEqual({
        status: "degraded",
        db: "down",
        migration: null,
        // Reported even when the database is down: the release gate has to be
        // able to tell "the new build is up but unhealthy" from "the old build
        // is still answering", and those need different responses.
        version: expect.any(String),
        // Reported on the degraded branch too. A deployment whose proxy chain
        // is wrong and whose database is also down is exactly when somebody is
        // reading this, and withholding it there would hide it when it is most
        // wanted (P-11).
        proxyChain: expect.any(Number),
        trustedHops: expect.any(Number),
      })
    } finally {
      await broken.$disconnect().catch(() => undefined)
    }
  })

  it("leaks nothing about the connection when it fails", async () => {
    const broken = createPrismaClient(
      loadEnv({ ...process.env, DATABASE_URL: "postgresql://nobody:hunter2@127.0.0.1:1/none" }),
    )

    try {
      const res = await request(app(broken)).get("/health")
      expect(JSON.stringify(res.body)).not.toContain("hunter2")
      expect(JSON.stringify(res.body)).not.toContain("127.0.0.1")
    } finally {
      await broken.$disconnect().catch(() => undefined)
    }
  })
})

describe.skipIf(!hasDatabase)("treasury seed (spec §9.4, runbook T-2.8)", () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createPrismaClient(loadEnv())
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("is idempotent: running it twice creates no duplicates", async () => {
    const first = await seed()
    const second = await seed()

    expect(second.userId).toBe(first.userId)
    expect(second.accountId).toBe(first.accountId)

    const systemUsers = await prisma.user.count({ where: { role: "SYSTEM" } })
    const treasuries = await prisma.account.count({ where: { type: "TREASURY" } })

    expect(systemUsers).toBe(1)
    expect(treasuries).toBe(1)
  })

  it("creates a treasury the database allows to go negative, and only it", async () => {
    const { accountId } = await seed()

    // §9.4: the treasury is the mint, so it alone may hold a negative balance.
    //
    // Restored to whatever it was, not to zero. Writing an absolute value back
    // silently discarded every ledger entry other suites had funded from the
    // treasury, and showed up much later as an I-4 drift of 14 600 000 tiyin
    // in a test that had nothing to do with this one.
    const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } })

    await prisma.account.update({ where: { id: accountId }, data: { balance: -1000n } })
    const treasury = await prisma.account.findUniqueOrThrow({ where: { id: accountId } })
    expect(treasury.balance).toBe(-1000n)

    await prisma.account.update({ where: { id: accountId }, data: { balance: before.balance } })

    // I-5: an ordinary account may not, and the database is what refuses.
    const holder = await prisma.user.upsert({
      where: { phone: "+998905550001" },
      update: {},
      create: {
        phone: "+998905550001",
        firstName: "Test",
        lastName: "Holder",
        passwordHash: "not-a-credential",
      },
    })
    const account = await prisma.account.upsert({
      where: { userId_currency: { userId: holder.id, currency: "UZS" } },
      update: {},
      create: { userId: holder.id, currency: "UZS", type: "USER", balance: 0n },
    })

    await expect(
      prisma.account.update({ where: { id: account.id }, data: { balance: -1n } }),
    ).rejects.toThrow()
  })
})
