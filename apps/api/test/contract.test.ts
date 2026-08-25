import type { PrismaClient } from "@prisma/client"
import { apiErrorSchema, isRetryable } from "@wallet/shared"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/adapters/http/app.js"
import { loadEnv } from "../src/config/env.js"
import { createLogger } from "../src/infra/logger.js"

/**
 * Exercises the app as it is actually composed, rather than a bespoke pipeline
 * assembled per test. The three failures below — wrong path, malformed body,
 * oversized body — are the ones a real client hits most, and every one of them
 * escaped §12.3 until a test called `createApp` itself.
 */

const PRISMA_STUB = {
  $queryRaw: async () => [{ migration_name: "00000000000000_stub" }],
} as unknown as PrismaClient

/** Captures the bytes the logger writes so log assertions read real output. */
function appWithCapturedLog() {
  const lines: string[] = []
  const env = loadEnv({ DATABASE_URL: "postgresql://unused", LOG_LEVEL: "info" })
  const log = createLogger(env, {
    write(chunk: string) {
      lines.push(chunk)
    },
  })
  return { app: createApp({ prisma: PRISMA_STUB, log }), logText: () => lines.join("") }
}

describe("framework failures stay inside the catalog (§12.3)", () => {
  it("an unrouted path returns the envelope, not an HTML page", async () => {
    const { app } = appWithCapturedLog()
    const res = await request(app).get("/api/does-not-exist")

    expect(res.status).toBe(404)
    expect(res.headers["content-type"]).toMatch(/application\/json/)
    expect(apiErrorSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("an unsupported method on a real path returns the envelope", async () => {
    const { app } = appWithCapturedLog()
    const res = await request(app).post("/health")

    expect(res.status).toBe(404)
    expect(apiErrorSchema.safeParse(res.body).success).toBe(true)
  })

  it("malformed JSON is a non-retryable 400, not a retryable 500", async () => {
    const { app } = appWithCapturedLog()
    const res = await request(app)
      .post("/api/does-not-exist")
      .set("content-type", "application/json")
      .send('{"phone": ')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("MALFORMED_BODY")
    // The whole point: FR-8.4 retries 5xx. A permanently broken payload retried
    // with backoff never succeeds and never stops.
    expect(isRetryable(res.body.error.code)).toBe(false)
  })

  it("an oversized body is a non-retryable 413", async () => {
    const { app } = appWithCapturedLog()
    const res = await request(app)
      .post("/api/does-not-exist")
      .set("content-type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(20_000) }))

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE")
    expect(isRetryable(res.body.error.code)).toBe(false)
  })

  it("a client mistake is not logged at error level", async () => {
    const { app, logText } = appWithCapturedLog()
    await request(app)
      .post("/api/does-not-exist")
      .set("content-type", "application/json")
      .send("{oops")

    expect(logText()).not.toContain('"level":"error"')
  })

  it("every failing response carries the request id from the header", async () => {
    const { app } = appWithCapturedLog()
    const res = await request(app).get("/api/does-not-exist")

    expect(res.body.error.requestId).toBe(res.headers["x-request-id"])
  })
})

describe("access logging never writes a subscriber identity (NFR-5.2)", () => {
  const PHONE = "+998901234567"

  it("keeps the query string out of the logged URL", async () => {
    const { app, logText } = appWithCapturedLog()
    await request(app).get(`/api/recipients/lookup?phone=${encodeURIComponent(PHONE)}`)

    const written = logText()
    expect(written).not.toContain(PHONE)
    expect(written).not.toContain(encodeURIComponent(PHONE))
    // The path is still there — the point is to lose the identity, not the trace.
    expect(written).toContain("/api/recipients/lookup")
  })

  it("redacts an unrecognised query parameter rather than allowing it through", async () => {
    const { app, logText } = appWithCapturedLog()
    await request(app).get("/api/x?password=hunter2&pin=1234&cursor=abc")

    const written = logText()
    expect(written).not.toContain("hunter2")
    expect(written).not.toContain("1234")
    // Allowlisted pagination keys survive, because they are what a trace needs.
    expect(written).toContain("abc")
  })

  it("does not write the Authorization header", async () => {
    const { app, logText } = appWithCapturedLog()
    await request(app).get("/api/x").set("authorization", "Bearer super-secret-value")

    expect(logText()).not.toContain("super-secret-value")
  })

  it("stays silent on a healthy health check but reports a failing one", async () => {
    const { app, logText } = appWithCapturedLog()
    await request(app).get("/health")
    expect(logText()).toBe("")

    const broken = {
      $queryRaw: async () => {
        throw new Error("db is gone")
      },
    } as unknown as PrismaClient
    const lines: string[] = []
    const env = loadEnv({ DATABASE_URL: "postgresql://unused", LOG_LEVEL: "info" })
    const log = createLogger(env, {
      write(chunk: string) {
        lines.push(chunk)
      },
    })
    const res = await request(createApp({ prisma: broken, log })).get("/health")

    expect(res.status).toBe(503)
    // A total database outage must not be the one event that leaves no trace.
    expect(lines.join("")).toContain('"level":"error"')
  })
})
