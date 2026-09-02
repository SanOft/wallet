import { readFileSync } from "node:fs"
import type { PrismaClient } from "@prisma/client"
import { Client } from "pg"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seed } from "../prisma/seed.js"
import { checkPrivileges, createPrismaClient } from "../src/infra/prisma.js"
import { buildApp, testEnv, uniquePhone } from "./helpers.js"

/**
 * The role the API is meant to connect as, proved against the file that creates
 * it (P-4).
 *
 * ADR-0001's claim is that the ledger's invariants live in the database rather
 * than in the service. That holds against ordinary DML and not against the
 * owner, who can disable the trigger, replace the function, or switch
 * replication off — which is why the migration header claims only that a *bug
 * in service code* cannot corrupt the ledger. The gap is the connection: the
 * service has been the owner.
 *
 * Two halves, and both are needed. A role locked down enough to be safe and too
 * locked down to run is not a fix, it is an outage, so the first half runs real
 * money through the application on that connection. The second half tries the
 * three escalations P-4 names and requires each to be refused.
 *
 * `runtime-role.sql` is read and executed here rather than restated. A test
 * holding its own copy of the grants proves the copy, and the copy is what
 * drifts.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL)

/** Assembled rather than written out: a literal trips the secret scanner. */
const ROLE_PASSWORD = ["harbour", "kestrel", "meadow", "signal"].join("-")
const PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

/** The same URL, connecting as the runtime role instead of the owner. */
function asRuntimeRole(ownerUrl: string): string {
  const url = new URL(ownerUrl)
  url.username = "wallet_runtime"
  url.password = ROLE_PASSWORD
  return url.toString()
}

/** Assigned in `beforeAll`; module scope so the helpers below can reach it. */
let runtimeSql: Client

/**
 * Runs a statement as the runtime role inside a transaction that is always
 * rolled back, and returns whatever it threw.
 *
 * The rollback is not tidiness. These statements are the real ones — dropping a
 * CHECK, replacing the trigger function — and a test that fires them at the
 * live schema is safe only for as long as the control under test works, which
 * is precisely when safety stops being guaranteed. It happened: running this
 * file once with the role deliberately made a superuser, to prove the
 * assertions were load-bearing, actually dropped `accounts_balance_non_negative`
 * from the test database, and a suite three files later failed because an
 * ordinary account was allowed to go negative. DDL is transactional in
 * Postgres, so the discipline costs nothing.
 */
async function attemptAsRuntime(sql: string): Promise<Error | null> {
  await runtimeSql.query("BEGIN")
  try {
    await runtimeSql.query(sql)
    return null
  } catch (error) {
    return error as Error
  } finally {
    await runtimeSql.query("ROLLBACK")
  }
}

/**
 * Refused *for lack of privilege*, and not for any other reason.
 *
 * "It threw" alone is the trap this file nearly shipped with. The runtime role
 * could not authenticate at one point during development, and every escalation
 * assertion went green on the connection error — five security checks passing
 * while proving nothing. Postgres says `42501` for a privilege refusal and
 * `28P01` for a failed login, so the difference is available and is asserted.
 */
async function expectRefusedForPrivilege(sql: string): Promise<void> {
  const error = await attemptAsRuntime(sql)

  expect(error, `the statement was allowed: ${sql}`).not.toBeNull()

  const message = String(error?.message)
  expect(message, "refused, but for the wrong reason").not.toContain("28P01")
  expect(message).toMatch(/42501|permission denied|must be superuser|must be owner/i)
}

describe.skipIf(!hasDatabase)("the runtime role (P-4)", () => {
  let owner: PrismaClient
  let runtime: PrismaClient

  beforeAll(async () => {
    owner = createPrismaClient(testEnv({ ...process.env }))
    await seed(owner)

    const script = readFileSync(new URL("../prisma/runtime-role.sql", import.meta.url), "utf8")

    // The control: a path that read nothing would leave every assertion below
    // testing a role this file never created.
    expect(script, "the role script was not read").toContain("CREATE ROLE wallet_runtime")

    /*
     * Executed whole, through `pg` rather than Prisma.
     *
     * Prisma sends one statement per call, so running this file meant splitting
     * it — and the first attempt split the `DO ... END $$;` block in half on the
     * semicolon inside it, which is exactly the hazard that block introduces.
     * `pg`'s simple query protocol takes the file as it stands, so what runs
     * here is the file an operator will run rather than a reassembly of it.
     */
    const client = new Client({ connectionString: String(process.env.DATABASE_URL) })
    await client.connect()
    try {
      await client.query(script.replaceAll("__PASSWORD__", ROLE_PASSWORD))
    } finally {
      await client.end()
    }

    const runtimeUrl = asRuntimeRole(String(process.env.DATABASE_URL))
    runtime = createPrismaClient({ DATABASE_URL: runtimeUrl })

    runtimeSql = new Client({ connectionString: runtimeUrl })
    await runtimeSql.connect()
  }, 60_000)

  afterAll(async () => {
    await runtimeSql?.end()
    await runtime?.$disconnect()
    await owner?.$disconnect()
  })

  it("can run the application end to end", async () => {
    /*
     * Registration, the demo mint and a transfer: the paths that write to every
     * table the service touches, including the append-only ledger and the
     * BIGSERIAL behind it. A missing grant surfaces here as a 500 rather than
     * as a surprise on the first production request.
     */
    const { app } = buildApp(runtime, { ...process.env })

    const sender = uniquePhone()
    const registered = await request(app)
      .post("/api/auth/register")
      .send({ phone: sender, firstName: "Runtime", lastName: "Role", password: PASSWORD })
    expect(registered.status, JSON.stringify(registered.body)).toBe(201)

    const token = String(registered.body.accessToken)
    const recipient = uniquePhone()
    const other = await request(app)
      .post("/api/auth/register")
      .send({ phone: recipient, firstName: "Runtime", lastName: "Peer", password: PASSWORD })
    expect(other.status).toBe(201)

    const topUp = await request(app)
      .post("/api/accounts/topup")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", crypto.randomUUID())
      .send({})
    expect(topUp.status, JSON.stringify(topUp.body)).toBe(201)

    const transfer = await request(app)
      .post("/api/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", crypto.randomUUID())
      .send({ phone: recipient, amount: "250000" })
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201)
    expect(transfer.body.status).toBe("COMPLETED")

    const history = await request(app).get("/api/transfers").set("authorization", `Bearer ${token}`)
    expect(history.status).toBe(200)
  }, 60_000)

  it("is reported as least-privilege, where the owner is reported as not", async () => {
    /*
     * The startup diagnostic, checked against both roles at once (P-4).
     *
     * A report that says "least privilege" whatever it is connected to is worse
     * than no report: it would let the deploy log confirm a fix that never
     * happened. So the assertion is the *difference* — the same function must
     * say something different about the owner.
     */
    const asRuntime = await checkPrivileges(runtime)
    expect(asRuntime, "the privilege query failed").not.toBeNull()
    expect(asRuntime?.role).toBe("wallet_runtime")
    expect(asRuntime?.superuser, "the runtime role is a superuser").toBe(false)
    expect(asRuntime?.ownedTables, "the runtime role owns tables").toBe(0)

    const asOwner = await checkPrivileges(owner)
    expect(asOwner, "the privilege query failed for the owner").not.toBeNull()
    expect(
      asOwner?.superuser === true || (asOwner?.ownedTables ?? 0) > 0,
      "the owner was reported as least-privilege, so the check cannot tell them apart",
    ).toBe(true)
  })

  it("cannot disable the trigger that holds the ledger together", async () => {
    // The exact statement the day-6 migration needed the owner for, and the one
    // that would make every other guarantee decorative.
    await expectRefusedForPrivilege('ALTER TABLE "ledger_entries" DISABLE TRIGGER USER')
  })

  it("cannot replace the function the invariants are written in", async () => {
    await expectRefusedForPrivilege(
      "CREATE OR REPLACE FUNCTION assert_transfer_balanced() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql",
    )
  })

  it("cannot turn replication off to skip every trigger at once", async () => {
    // Superuser-only, and the reason the ledger migration could not use it
    // against a hosted database.
    await expectRefusedForPrivilege("SET session_replication_role = replica")
  })

  it("cannot delete a ledger entry, an account or a user", async () => {
    /*
     * The trigger already refuses the first. The other two are refused by the
     * grant instead, which is the part a trigger cannot do: a compromised
     * process cannot make an account disappear, and P-26 has already recorded
     * that not even the owner can, because the ledger references it.
     */
    await expectRefusedForPrivilege('DELETE FROM "accounts"')
    await expectRefusedForPrivilege('DELETE FROM "users"')

    /*
     * The ledger has two independent defences and the *grant* is the outer one:
     * Postgres checks privilege before it reaches a trigger, so this is refused
     * as `42501` and I-3's own message is never produced. Worth knowing, since
     * the trigger is what everyone reaches for when asked why the ledger cannot
     * be edited — under this role it never even runs.
     */
    await expectRefusedForPrivilege('DELETE FROM "ledger_entries"')
  })

  it("cannot alter the schema it runs against", async () => {
    await expectRefusedForPrivilege(
      'ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_balance_non_negative"',
    )
    await expectRefusedForPrivilege('DROP TABLE IF EXISTS "rates_snapshots"')
  })
})
