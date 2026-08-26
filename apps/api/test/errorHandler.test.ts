import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  apiErrorCodeSchema,
  apiErrorSchema,
} from "@wallet/shared"
import express from "express"
import request from "supertest"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createErrorHandler } from "../src/adapters/http/middleware/errorHandler.js"
import { requestId } from "../src/adapters/http/middleware/requestId.js"
import { DomainError, ValidationError } from "../src/domain/errors.js"
import type { Logger } from "../src/infra/logger.js"

/** A logger that records rather than prints, so assertions can read it. */
function stubLogger() {
  const calls: { level: string; obj: unknown; msg: string }[] = []
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      calls.push({ level, obj, msg: msg ?? "" })
    }
  const log = {
    error: vi.fn(record("error")),
    warn: vi.fn(record("warn")),
    info: vi.fn(record("info")),
    debug: vi.fn(record("debug")),
  } as unknown as Logger
  return { log, calls }
}

function appThatThrows(thrown: unknown, log: Logger) {
  const app = express()
  app.use(requestId)
  app.get("/boom", () => {
    throw thrown
  })
  app.use(createErrorHandler(log))
  return app
}

describe("error envelope (spec §12.3)", () => {
  /**
   * Transcribed by hand from spec §12.3. Asserting against API_ERROR_STATUS
   * instead would only prove the handler dereferences the same map it reads —
   * a typo in the map would keep such a test green while breaking the contract.
   */
  const SPEC_12_3: ReadonlyArray<readonly [ApiErrorCode, number]> = [
    ["VALIDATION_ERROR", 400],
    ["REGISTRATION_FAILED", 400],
    ["AUTH_INVALID_CREDENTIALS", 401],
    ["AUTH_TOKEN_EXPIRED", 401],
    ["AUTH_REFRESH_REUSED", 401],
    ["AUTH_REFRESH_INVALID", 401],
    ["AUTH_LOCKED", 429],
    ["RATE_LIMITED", 429],
    ["NOT_FOUND", 404],
    ["MALFORMED_BODY", 400],
    ["PAYLOAD_TOO_LARGE", 413],
    ["RECIPIENT_NOT_FOUND", 404],
    ["SELF_TRANSFER_FORBIDDEN", 422],
    ["INSUFFICIENT_FUNDS", 422],
    ["LIMIT_EXCEEDED", 422],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["PIN_NOT_SET", 422],
    ["PIN_LOCKED", 429],
    ["INTERNAL", 500],
  ]

  it("the status map matches the catalog transcribed from the spec", () => {
    // Guards the map itself, independently of any handler.
    for (const [code, status] of SPEC_12_3) {
      expect(API_ERROR_STATUS[code], code).toBe(status)
    }
    // And guards against a code existing that the transcription forgot.
    expect(new Set(apiErrorCodeSchema.options)).toEqual(new Set(SPEC_12_3.map(([c]) => c)))
  })

  it("every API error code returns its documented HTTP status", async () => {
    for (const [code, status] of SPEC_12_3) {
      const { log } = stubLogger()
      const res = await request(appThatThrows(new DomainError(code, "boom"), log)).get("/boom")

      expect(res.status, `${code} status`).toBe(status)
      expect(res.body.error.code, `${code} body code`).toBe(code)
    }
  })

  it("the response always parses through apiErrorSchema", async () => {
    const { log } = stubLogger()
    const res = await request(appThatThrows(new DomainError("INSUFFICIENT_FUNDS", "no"), log)).get(
      "/boom",
    )

    expect(apiErrorSchema.safeParse(res.body).success).toBe(true)
  })

  it("carries the request id that the response header advertises", async () => {
    const { log } = stubLogger()
    const res = await request(appThatThrows(new DomainError("RATE_LIMITED", "slow down"), log)).get(
      "/boom",
    )

    expect(res.body.error.requestId).toBe(res.headers["x-request-id"])
  })
})

describe("unexpected failures", () => {
  it("become INTERNAL 500 and never leak the cause", async () => {
    const { log } = stubLogger()
    const res = await request(appThatThrows(new Error("connection string leaked here"), log)).get(
      "/boom",
    )

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe("INTERNAL")
    expect(JSON.stringify(res.body)).not.toContain("connection string leaked here")
    expect(JSON.stringify(res.body)).not.toContain("stack")
  })

  it("are logged with the request id so the response can be traced", async () => {
    const { log, calls } = stubLogger()
    const res = await request(appThatThrows(new Error("kaboom"), log)).get("/boom")

    const logged = calls.find((c) => c.level === "error")
    if (!logged) throw new Error("expected the handler to log the unexpected failure")
    expect((logged.obj as { requestId: string }).requestId).toBe(res.body.error.requestId)
  })
})

describe("validation errors", () => {
  it("map Zod issues carrying a field code into details", async () => {
    const { log } = stubLogger()
    const schema = z.object({ phone: z.string().regex(/^\+/, { error: "phone.invalid_format" }) })
    const parsed = schema.safeParse({ phone: "998901234567" })
    expect(parsed.success).toBe(false)

    const res = await request(appThatThrows(parsed.error, log)).get("/boom")

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(res.body.error.details).toEqual([{ path: ["phone"], code: "phone.invalid_format" }])
  })

  it("drop an issue whose message is not a known field code, and warn about it", async () => {
    const { log, calls } = stubLogger()
    // No `error` value, so Zod supplies its own English message — which is not
    // in the closed field-code enum.
    const schema = z.object({ nickname: z.string() })
    const parsed = schema.safeParse({ nickname: 42 })
    expect(parsed.success).toBe(false)

    const res = await request(appThatThrows(parsed.error, log)).get("/boom")

    // The reason could not be mapped, but the client is still told which field
    // failed — an empty details array would leave it nothing to render.
    expect(res.body.error.details).toEqual([{ path: ["nickname"], code: "field.required" }])
    expect(calls.some((c) => c.level === "warn")).toBe(true)
  })

  it("keeps details on LIMIT_EXCEEDED, which §12.3 says names which limit", async () => {
    const { log } = stubLogger()
    const err = new DomainError("LIMIT_EXCEEDED", "over", [
      { path: ["amount"], code: "limit.daily" },
    ])
    const res = await request(appThatThrows(err, log)).get("/boom")

    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual([{ path: ["amount"], code: "limit.daily" }])
  })

  it("omits details on a code the catalog gives none", async () => {
    const { log } = stubLogger()
    const err = new DomainError("INSUFFICIENT_FUNDS", "no funds", [
      { path: ["amount"], code: "money.below_minimum" },
    ])
    const res = await request(appThatThrows(err, log)).get("/boom")

    expect(res.body.error).not.toHaveProperty("details")
  })

  it("keeps details for a ValidationError raised by the domain", async () => {
    const { log } = stubLogger()
    const err = new ValidationError([{ path: ["amount"], code: "money.below_minimum" }])
    const res = await request(appThatThrows(err, log)).get("/boom")

    expect(res.status).toBe(400)
    expect(res.body.error.details).toEqual([{ path: ["amount"], code: "money.below_minimum" }])
  })
})
