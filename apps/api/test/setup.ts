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
