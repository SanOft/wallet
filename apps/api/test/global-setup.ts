import { fileURLToPath } from "node:url"
import { Client } from "pg"

/**
 * Runs once per `vitest` invocation, before any suite (P-17).
 *
 * Two problems, both of which made a green run mean less than it looked like.
 *
 * **It failed open.** `describe.skipIf(!hasDatabase)` guards twenty-two blocks
 * across nine files. Without a `DATABASE_URL` those blocks disappear and the
 * run still reports success — which is the correct behaviour on a laptop with
 * no database, and exactly the wrong behaviour in CI, where a missing variable
 * means the workflow is broken and the answer should be a red build rather
 * than a green one with a third of the tests silently absent.
 *
 * **It never cleaned up.** The suites write and delete nothing, so a shared
 * development database accumulated 2 804 users, 2 409 transfers and 4 478
 * ledger entries. That is not merely untidy: an I-4 drift of 2 300 000 tiyin
 * settled into it and persisted across every later run, turning four tests red
 * against unmutated code. CI never saw any of it, because CI gets a fresh
 * container each time — so the only environment that keeps state was the one
 * with no reset.
 *
 * Truncating once per run rather than per file: files already seed the treasury
 * they need in `beforeAll`, and a wipe between them would only add work. What
 * matters is that a run never inherits the previous run's rows.
 */

/**
 * Left alone. Prisma reads it to decide what to apply, and truncating it turns
 * the next `migrate deploy` into a full re-run against a schema that already
 * has the tables.
 */
const KEEP = new Set(["_prisma_migrations"])

export async function setup(): Promise<void> {
  /*
   * Loads `.env` itself rather than relying on `test/setup.ts`, and the first
   * version of this file did rely on it — which is why the first run of it
   * reset nothing at all and said nothing about that.
   *
   * `setupFiles` run per test file, *after* `globalSetup`, so at this point
   * `TEST_DATABASE_URL` was still undefined and the "no database configured"
   * branch below swallowed it. A green suite and 181 more rows in the database
   * was the only evidence. Exactly the silent no-op this file exists to remove.
   */
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)))
  } catch {
    // Environment supplies the variables, or the branch below handles it.
  }

  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

  if (!url) {
    /*
     * The whole point of the fail-closed half. `CI` is set by GitHub Actions
     * on every runner, so this cannot fire on a developer machine that simply
     * has no database — where skipping is right and stated in the runbook.
     */
    if (process.env.CI) {
      throw new Error(
        "no DATABASE_URL in CI: the database-backed suites would skip silently and the run " +
          "would still report success. Twenty-two describe blocks depend on it.",
      )
    }

    /*
     * Loud on a developer machine too, even though skipping is the intended
     * behaviour there. "Correct to skip" and "fine to say nothing about" are
     * different claims: a run that omits nine files and then prints a green
     * summary is a run somebody will quote as evidence. This line is what keeps
     * that from being an honest mistake.
     */
    console.warn(
      "\n  NO DATABASE - nine suites will not run, and the summary will still say passed." +
        "\n  Set TEST_DATABASE_URL (docs/runbook.md) to include them.\n",
    )
    return
  }

  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    const { rows } = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    )
    const tables = rows.map((r) => r.tablename).filter((t) => !KEEP.has(t))
    if (tables.length === 0) return

    /*
     * `session_replication_role` because the ledger is append-only by trigger:
     * `ledger_entries` rejects UPDATE, DELETE and TRUNCATE outright, which is
     * the guarantee the product is built on and not something to weaken for a
     * test. Suspending triggers for one statement, inside one transaction, is
     * narrower than granting the suite a way through them.
     *
     * It needs rights the application role should not have (P-4). That is
     * acceptable here and only here: this connection points at the throwaway
     * test database, never at the one the API runs against.
     */
    await client.query("begin")
    await client.query("set local session_replication_role = 'replica'")
    await client.query(
      `truncate table ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`,
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    /*
     * Rethrown rather than warned about. A teardown that quietly does nothing
     * is the state this file was written to leave behind, and it would be
     * invisible again within a week.
     */
    throw new Error(`could not reset the test database: ${(error as Error).message}`)
  } finally {
    await client.end()
  }
}
