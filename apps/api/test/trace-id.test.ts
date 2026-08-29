import { randomUUID } from "node:crypto"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { buildApp, PRISMA_STUB } from "./helpers.js"

/**
 * The correlation key the logs are keyed on is the server's, not the caller's
 * (P-24).
 *
 * §17.1 answers Repudiation — "I never sent this money" — with the ledger, the
 * channel and these logs. The format check on `x-request-id` stopped log
 * injection, which was its stated purpose, and it never made the value
 * *evidence*: a caller may put one id on a thousand requests, or reuse one it
 * read out of an error message, and every line about those requests then reads
 * as a single event.
 *
 * So the caller keeps its id — it is echoed, and a client correlating its own
 * call is why the header exists — and the log gains one the caller cannot
 * touch.
 */

/*
 * No env override, deliberately. Passing `process.env` through picks up the
 * developer's `LOG_LEVEL`, and a quiet one writes no access log at all — which
 * made the first version of these tests assert against an empty string and
 * report that nothing carried a trace id.
 */
function app() {
  return buildApp(PRISMA_STUB)
}

/**
 * Every trace id the logger wrote, from either place one can appear.
 *
 * The access log nests it under `req`, because it comes out of the request
 * serializer; the error handler writes it at the top level, because it logs
 * directly. Looking in one place only is how an earlier version of this file
 * reported that nothing carried a trace id while the access log carried one.
 */
function tracesIn(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as { traceId?: unknown; req?: { traceId?: unknown } })
    .map((line) => line.traceId ?? line.req?.traceId)
    .filter((id): id is string => typeof id === "string")
}

describe("the id a repudiation claim is checked against", () => {
  it("echoes the caller's id, because that is what the header is for", async () => {
    const supplied = randomUUID()
    const { app: instance } = app()

    const res = await request(instance).get("/api/rates").set("x-request-id", supplied)

    expect(res.headers["x-request-id"]).toBe(supplied)
  })

  it("logs a different id, which the caller did not choose", async () => {
    const supplied = randomUUID()
    const { app: instance, logText } = app()

    await request(instance).get("/api/rates").set("x-request-id", supplied)

    const traces = tracesIn(logText())
    expect(traces.length, "no log line carried a traceId").toBeGreaterThan(0)

    for (const trace of traces) {
      expect(trace, "the trace id is the one the caller supplied").not.toBe(supplied)
      expect(trace).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it("gives two requests distinct trace ids even when they claim the same one", async () => {
    /*
     * The attack the format check does not touch. Both requests are
     * well-formed and identical as far as `x-request-id` is concerned, so a log
     * keyed on that value cannot tell them apart — which is exactly what
     * somebody denying one of them would want.
     */
    const collided = randomUUID()
    const { app: instance, logText } = app()

    await request(instance).get("/api/rates").set("x-request-id", collided)
    await request(instance).get("/api/rates").set("x-request-id", collided)

    expect(new Set(tracesIn(logText())).size, "two requests shared one trace id").toBeGreaterThan(1)
  })

  it("keeps the caller's id in the error envelope", async () => {
    /*
     * Unchanged on purpose. §12.3 puts `requestId` in the body so a client can
     * quote it back, and a client quoting an id it chose is the normal case.
     * The trace id is for whoever reads the logs; putting it on the wire would
     * add a value nothing consumes.
     */
    const supplied = randomUUID()
    const { app: instance } = app()

    const res = await request(instance).get("/api/nothing-here").set("x-request-id", supplied)

    expect(res.status).toBe(404)
    expect(res.body.error.requestId).toBe(supplied)
    expect(JSON.stringify(res.body)).not.toContain("traceId")
  })
})
