import { createApp } from "./adapters/http/app.js"
import { loadEnv } from "./config/env.js"
import { createLogger } from "./infra/logger.js"
import { createPrismaClient } from "./infra/prisma.js"

/**
 * Process entrypoint. Everything it touches is constructed here and passed
 * down, so no module reaches for `process.env` or a global client on its own.
 */
async function main(): Promise<void> {
  // Throws before anything else starts if configuration is incomplete (NFR-1.9).
  const env = loadEnv()
  const log = createLogger(env)
  const prisma = createPrismaClient(env)

  const app = createApp({ prisma, log })
  const server = app.listen(env.PORT, () => {
    log.info({ port: env.PORT, env: env.NODE_ENV }, "wallet-api listening")
  })

  /**
   * Render sends SIGTERM and then kills the process. Without this, in-flight
   * requests are severed mid-response and the connection pool is dropped
   * without telling Postgres, which leaves sessions to time out on their own.
   */
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, "shutting down")

    server.close((closeError) => {
      void prisma
        .$disconnect()
        .catch((disconnectError: unknown) => {
          log.error({ err: disconnectError }, "failed to close the database pool")
        })
        .finally(() => {
          process.exit(closeError ? 1 : 0)
        })
    })
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((error: unknown) => {
  // The logger may not exist yet — a bad DATABASE_URL fails before it is built
  // — so this deliberately uses the console and a non-zero exit.
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
