import { fileURLToPath } from "node:url"

/**
 * Loads the local `.env` so integration tests find DATABASE_URL, and tolerates
 * its absence: in CI the value comes from the workflow, and on a machine with
 * no database the DB-backed suites skip themselves rather than fail.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)))
} catch {
  // Environment supplies the variables, or the integration suites will skip.
}

/**
 * Point the integration suites at their own database, when one is configured.
 *
 * P-31: these tests and the development server were reading the same
 * `DATABASE_URL`, so a test fixture became a row the running application then
 * served to a real session. That is not hypothetical — the rates widget showed
 * `11900.00` dated tomorrow, written by `rates.test.ts`, for hours. The same
 * sharing left 3 440 accounts and 2 101 transfers behind, which is what made
 * the I-4 invariant check time out until it was rewritten.
 *
 * A fallback rather than a requirement, deliberately. Making `TEST_DATABASE_URL`
 * mandatory would fail every existing checkout and every CI job that already
 * provisions exactly one database, to fix a problem those jobs do not have —
 * a throwaway container has nothing to protect. Where it is set, the tests move;
 * where it is not, nothing changes.
 */
/**
 * Registration answers in constant time in production and immediately here
 * (P-13).
 *
 * `REGISTRATION_TIME_BUDGET_MS` holds every registration to a fixed duration so
 * a refusal cannot be told from an acceptance by how long it took. The suite
 * registers several hundred accounts, and a quarter second each would add
 * minutes to a run that is meant to be fast enough to sit and watch.
 *
 * Switching a security control off for the tests is exactly the move that hides
 * one, so it is not left implicit: `constant-time-registration.test.ts` asserts
 * the production default is non-zero and builds its own app with a budget to
 * prove the padding works. Turning it off here cannot turn it off there.
 */
process.env.REGISTRATION_TIME_BUDGET_MS ??= "0"

const testDatabase = process.env.TEST_DATABASE_URL
if (testDatabase) {
  process.env.DATABASE_URL = testDatabase
  // The migration path reads this one, and leaving it pointed at the previous
  // database would send DDL somewhere the tests are no longer looking — the
  // failure mode being "no pending migrations to apply", which reads as
  // success.
  process.env.DATABASE_URL_UNPOOLED = testDatabase
}
