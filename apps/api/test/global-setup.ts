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

  /*
   * `TEST_DATABASE_URL` only. This deliberately does **not** fall back to
   * `DATABASE_URL`, and the fallback is what a security review caught here.
   *
   * This function truncates every table it finds. Reached through the
   * fallback, that is a `yarn test` that wipes whichever database the
   * development server is pointed at — which on this very machine held a real
   * account with a balance and three transfers. The suites still fall back for
   * *reading* (`test/setup.ts`, P-31, and CI depends on it), because reading a
   * shared database is untidy and destroying one is not the same kind of
   * mistake.
   *
   * So: a database nobody explicitly nominated as the test database is never
   * truncated, and the run says why rather than appearing to have reset
   * something.
   */
  const url = process.env.TEST_DATABASE_URL
  const fallback = process.env.DATABASE_URL

  if (!url) {
    /*
     * A database exists, but not one nominated for tests. The suites will run
     * against it — `test/setup.ts` falls back, and CI relies on that — and
     * nothing here will delete anything.
     */
    if (fallback) {
      console.warn(
        "\n  NOT resetting the database: TEST_DATABASE_URL is unset, so the suites are sharing" +
          "\n  DATABASE_URL and rows will accumulate (P-31). Nothing is truncated without an" +
          "\n  explicit test database, because that database may not be a throwaway.\n",
      )
      return
    }

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
    /*
     * Checked against the connection rather than against the environment
     * variable, because the variable is the thing that would be wrong.
     * `current_database()` is what is actually about to be emptied.
     */
    const { rows: identity } = await client.query<{ name: string }>(
      "select current_database() as name",
    )
    const name = identity[0]?.name ?? ""
    if (!/test/i.test(name)) {
      throw new Error(
        `refusing to truncate "${name}": TEST_DATABASE_URL does not name a test database. ` +
          "Rename it, or point it at one — this statement deletes every row it finds.",
      )
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error("refusing to truncate anything with NODE_ENV=production")
    }

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
