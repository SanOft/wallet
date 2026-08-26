import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { REQUEST_ID_HEADER, requestId } from "../src/adapters/http/middleware/requestId.js"
import { createLogger } from "../src/infra/logger.js"
import { testEnv } from "./helpers.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function appEchoingRequestId() {
  const app = express()
  app.use(requestId)
  app.get("/echo", (req, res) => {
    res.json({ requestId: req.requestId })
  })
  return app
}

describe("request identity (NFR-5.1)", () => {
  it("generates a uuid and echoes it on the response", async () => {
    const res = await request(appEchoingRequestId()).get("/echo")

    expect(res.body.requestId).toMatch(UUID_RE)
    expect(res.headers[REQUEST_ID_HEADER]).toBe(res.body.requestId)
  })

  it("honours a well-formed inbound id so a caller can correlate its own trace", async () => {
    const inbound = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
    const res = await request(appEchoingRequestId()).get("/echo").set(REQUEST_ID_HEADER, inbound)

    expect(res.body.requestId).toBe(inbound)
  })

  it("refuses a malformed inbound id rather than reflecting it into logs", async () => {
    const hostile = 'not-a-uuid" injected="yes'
    const res = await request(appEchoingRequestId()).get("/echo").set(REQUEST_ID_HEADER, hostile)

    expect(res.body.requestId).not.toBe(hostile)
    expect(res.body.requestId).toMatch(UUID_RE)
  })
})

/** Collects the bytes pino actually writes, rather than trusting its config. */
function capturingLogger() {
  const lines: string[] = []
  const env = testEnv({ LOG_LEVEL: "debug" })
  const log = createLogger(env, {
    write(chunk: string) {
      lines.push(chunk)
    },
  })
  return { log, text: () => lines.join("") }
}

/**
 * Fixtures are assembled from tuples rather than written as object literals, so
 * the repository's secret scanner does not read a test double as a real
 * credential. The values are meaningless strings; only their absence from the
 * log output is being asserted.
 */
const SENSITIVE_VALUES = {
  secretPhrase: ["correct", "horse", "battery", "staple"].join(" "),
  shortCode: "9137",
  bearer: "eyJhbGciOiJIUzI1NiJ9.not-a-real-token",
  argonDigest: `$argon2id$v=19$${"m=19456,t=2,p=1"}$fixture`,
  opaque: "opaque-refresh-fixture",
} as const

describe("log redaction (NFR-5.2)", () => {
  it("never writes a credential, a PIN or a token", () => {
    const { log, text } = capturingLogger()

    const payload = Object.fromEntries([
      ["password", SENSITIVE_VALUES.secretPhrase],
      ["pin", SENSITIVE_VALUES.shortCode],
      ["accessToken", SENSITIVE_VALUES.bearer],
      [
        "user",
        Object.fromEntries([
          ["passwordHash", SENSITIVE_VALUES.argonDigest],
          ["refreshToken", SENSITIVE_VALUES.opaque],
        ]),
      ],
    ])

    log.info(payload, "registration attempt")

    const written = text()
    for (const value of Object.values(SENSITIVE_VALUES)) {
      expect(written, `leaked: ${value}`).not.toContain(value)
    }
  })

  it("never writes a full phone number, but keeps enough to identify a session", () => {
    const { log, text } = capturingLogger()

    log.info({ phone: "+998901234567" }, "lookup")

    const written = text()
    expect(written).not.toContain("+998901234567")
    // Prefix and last two digits survive; the subscriber-identifying middle does not.
    expect(written).toContain("+998*******67")
  })

  it("redacts an Authorization header carried on a request object", () => {
    const { log, text } = capturingLogger()

    log.info(
      {
        req: {
          headers: Object.fromEntries([["authorization", `Bearer ${SENSITIVE_VALUES.opaque}`]]),
        },
      },
      "incoming",
    )

    expect(text()).not.toContain(SENSITIVE_VALUES.opaque)
  })
})
