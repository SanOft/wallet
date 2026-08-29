import { publicUserSchema } from "@wallet/shared"
import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { respond } from "../src/adapters/http/respond.js"

/**
 * T-3.8 says `passwordHash` is *provably* never on the wire. That word is only
 * earned if something is proved, so these tests hand `respond()` the shapes it
 * is supposed to defend against rather than the pre-narrowed objects the
 * production call sites already build.
 *
 * A review found the helper was a no-op across the whole suite — every caller
 * handed it an object that was already safe, so deleting the helper left every
 * test green. These are the tests that would have failed.
 */

function appReturning(value: unknown) {
  const app = express()
  app.get("/probe", (_req, res) => {
    respond(res, 200, publicUserSchema, value)
  })
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res
        .status(500)
        .json({ failed: true, message: err instanceof Error ? err.message : "unknown" })
    },
  )
  return app
}

/** The shape a Prisma `findUnique` with no `select` actually returns. */
const FULL_USER_ROW = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  phone: "+998901234567",
  firstName: "Alisher",
  lastName: "Navoiy",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$digest",
  pinHash: "$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0$digest",
  pinLockedUntil: null,
  role: "USER",
  createdAt: new Date("2026-08-26T00:00:00Z"),
}

describe("respond() strips what the schema does not name", () => {
  it("refuses a raw user row outright, rather than quietly trimming it", async () => {
    const res = await request(appReturning(FULL_USER_ROW)).get("/probe")

    /*
     * This used to be a 200 with the extra columns stripped, and the change is
     * a strengthening rather than a regression.
     *
     * `publicUserSchema` now carries `pinSet`, which is *derived* from
     * `pinHash` and cannot be produced by trimming — so a database row no
     * longer satisfies the contract at all, and handing one to `respond()` is
     * a 500 with a logged cause instead of a response that happened to be
     * safe. Silent trimming protected this route; a schema that cannot be
     * satisfied by a raw row protects every route somebody writes next.
     */
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain("$argon2")
  })

  it("passes a mapped user through and carries no credential with it", async () => {
    const mapped = {
      id: FULL_USER_ROW.id,
      phone: FULL_USER_ROW.phone,
      firstName: FULL_USER_ROW.firstName,
      lastName: FULL_USER_ROW.lastName,
      pinSet: FULL_USER_ROW.pinHash !== null,
    }

    const res = await request(
      appReturning({ ...mapped, passwordHash: FULL_USER_ROW.passwordHash }),
    ).get("/probe")

    expect(res.status).toBe(200)
    expect(res.body).toEqual(mapped)

    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain("passwordHash")
    expect(wire).not.toContain("pinHash")
    expect(wire).not.toContain("$argon2")
    expect(wire).not.toContain("role")
  })

  it("fails loudly rather than sending a body that breaks its own contract", async () => {
    // A missing field is a defect, and it should surface as our 500 with a
    // logged cause — not as a half-correct body the client has to guess at.
    const res = await request(appReturning({ id: "x", phone: "+998901234567" })).get("/probe")

    expect(res.status).toBe(500)
    expect(res.body.failed).toBe(true)
  })
})
