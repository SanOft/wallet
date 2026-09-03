import { createApp } from "./adapters/http/app.js"
import { loadEnv } from "./config/env.js"
import { AccountService } from "./domain/AccountService.js"
import { AuthService } from "./domain/AuthService.js"
import { RatesService } from "./domain/RatesService.js"
import { TransferService } from "./domain/TransferService.js"
import { fetchCbuRates } from "./infra/cbu.js"
import { warmDummyHash } from "./infra/crypto.js"
import { createTokenService } from "./infra/jwt.js"
import { createLogger } from "./infra/logger.js"
import { checkDatabase, checkPrivileges, createPrismaClient } from "./infra/prisma.js"
import { RatesRepository } from "./infra/RatesRepository.js"

/**
 * Process entrypoint. Everything it touches is constructed here and passed
 * down, so no module reaches for `process.env` or a global client on its own.
 */
async function main(): Promise<void> {
  // Throws before anything else starts if configuration is incomplete (NFR-1.9).
  const env = loadEnv()
  const log = createLogger(env)
  const prisma = createPrismaClient(env)

  /**
   * Without these, a pool error with no listener crashes the process and Node's
   * default handler prints the raw stack to stderr — outside pino, and so
   * outside every redaction rule in NFR-5.2.
   */
  process.on("uncaughtException", (error: unknown) => {
    log.fatal({ err: error }, "uncaught exception; exiting")
    process.exit(1)
  })
  process.on("unhandledRejection", (reason: unknown) => {
    log.fatal({ err: reason }, "unhandled rejection; exiting")
    process.exit(1)
  })

  /*
   * Says out loud how much this deployment could lose if the process were
   * taken over (P-4).
   *
   * `warn` rather than `info` when the role is over-privileged, because the
   * gap is real and silent: everything works exactly the same either way, so
   * nothing else would ever mention it. `runtime-role.sql` is the fix and the
   * runbook's T-6.1 section says how to apply it.
   */
  const privileges = await checkPrivileges(prisma)
  if (privileges === null) {
    log.warn({ event: "db.privileges_unknown" }, "could not read the connecting role's privileges")
  } else if (privileges.superuser || privileges.ownedTables > 0) {
    log.warn(
      { event: "db.over_privileged", ...privileges },
      "the API owns the tables it writes to; a compromised process could rewrite the ledger's rules (P-4)",
    )
  } else {
    log.info(
      { event: "db.least_privilege", ...privileges },
      "connected as a role that owns nothing",
    )
  }

  /*
   * Which migration this database is on, in the deploy log rather than on
   * `/health` (§19.1).
   *
   * The name is what tells an operator the API and the schema are in step
   * during a deploy window, and it used to be served to anyone who asked: it
   * dates the schema a caller is probing, which is a free hint about which of
   * its published gaps are still open. The audience is the person reading the
   * deploy anyway, so this is where it goes — the same argument the privilege
   * report above is written down for.
   *
   * Never fatal, for that same reason: a boot that failed because a diagnostic
   * could not be read would be an outage caused by a report. The failure is
   * `/health`'s to announce, not this line's.
   */
  const database = await checkDatabase(prisma)
  if (database.ok) {
    log.info({ event: "db.migration", migration: database.migration }, "database schema")
  } else {
    log.warn(
      { event: "db.migration_unknown", cause: database.error },
      "could not read the applied migration",
    )
  }

  // Pay the first argon2 cost at startup rather than on the first login for
  // an unknown number, which would otherwise answer measurably slower.
  await warmDummyHash()

  const tokens = createTokenService(env)
  const auth = new AuthService({
    prisma,
    tokens,
    pepper: env.JWT_SECRET,
    registrationBudgetMs: env.REGISTRATION_TIME_BUDGET_MS,
    warn: (event, detail) => log.warn({ event, ...(detail as object) }, "auth"),
  })
  /*
   * One per process, because it holds FR-4.9's lookup window in memory and
   * both channels have to share the same one — which is the whole point of
   * P-34. A second instance is a second budget.
   */
  const accounts = new AccountService({ prisma })

  const transfers = new TransferService({
    prisma,
    // FR-2.8's confirmation is the account password, so `AuthService` verifies
    // it and it waits behind the same backoff a sign-in does.
    confirmPassword: (userId, password) => auth.confirmPassword(userId, password),
    warn: (event, cause) => log.warn({ event, err: cause }, "transfer degraded"),
  })
  const rates = new RatesService({
    fetcher: fetchCbuRates,
    store: new RatesRepository(prisma),
    // `warn`, not `error`: none of these fail a request, and a log level that
    // pages someone for a degraded widget is a log level that gets muted.
    warn: (event, cause) => log.warn({ event, err: cause }, "rates degraded"),
  })

  const app = createApp({ prisma, log, env, auth, accounts, tokens, transfers, rates })
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
