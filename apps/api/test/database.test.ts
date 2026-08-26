import type { PrismaClient } from "@prisma/client"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { createApp } from "../src/adapters/http/app.js"
import { loadEnv } from "../src/config/env.js"
import { createLogger } from "../src/infra/logger.js"
import { createPrismaClient } from "../src/infra/prisma.js"

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
    const log = createLogger(loadEnv({ ...process.env, LOG_LEVEL: "fatal" }))
    return createApp({ prisma: client, log })
  }

  it("returns 200 with the documented shape and the applied migration", async () => {
    const res = await request(app(prisma)).get("/health")

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: "ok",
      db: "up",
      migration: expect.stringMatching(/^\d{14}_/),
    })
  })

  it("reports 503 when the database is unreachable rather than lying with a 200", async () => {
    const broken = createPrismaClient(
      loadEnv({ ...process.env, DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/none" }),
    )

    try {
      const res = await request(app(broken)).get("/health")

      expect(res.status).toBe(503)
      expect(res.body).toEqual({ status: "degraded", db: "down", migration: null })
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
    await prisma.account.update({ where: { id: accountId }, data: { balance: -1000n } })
    const treasury = await prisma.account.findUniqueOrThrow({ where: { id: accountId } })
    expect(treasury.balance).toBe(-1000n)
    await prisma.account.update({ where: { id: accountId }, data: { balance: 0n } })

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
