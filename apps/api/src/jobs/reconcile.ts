import { loadEnv } from "../config/env.js"
import { createLogger } from "../infra/logger.js"
import { createPrismaClient } from "../infra/prisma.js"
import { isHealthy, reconcile } from "../infra/reconciliation.js"

/**
 * The daily reconciliation §20.4 asks for, as a command.
 *
 * It existed as a function nothing called: no scheduler, no script, no wiring,
 * and therefore no alarm — a reader of §20.4 would have concluded the control
 * was in place. A function invoked only by its own test is not a control, it
 * is a fixture.
 *
 * `.github/workflows/reconcile.yml` runs it daily at 03:17 UTC, and on request.
 * It exits non-zero on a discrepancy, which fails that run — and a failed
 * scheduled run is what reaches the owner, rather than a fatal log nobody is
 * watching for.
 */
export async function runReconciliation(): Promise<boolean> {
  const env = loadEnv()
  const log = createLogger(env)
  const prisma = createPrismaClient(env)

  try {
    const report = await reconcile(prisma)

    if (isHealthy(report)) {
      log.info(
        { checkedAt: report.checkedAt.toISOString(), globalSum: report.globalSum.toString() },
        "reconciliation clean",
      )
      return true
    }

    /**
     * §20.4: "any discrepancy is logged at level `fatal` (this must never
     * happen)". `fatal` is right precisely because it is not actionable by a
     * retry — two records of the same money disagree, and waiting resolves
     * nothing.
     */
    log.fatal(
      {
        checkedAt: report.checkedAt.toISOString(),
        globalSum: report.globalSum.toString(),
        driftedAccounts: report.drifts.length,
        drifts: report.drifts.slice(0, 20).map((drift) => ({
          accountId: drift.accountId,
          snapshot: drift.snapshot.toString(),
          journal: drift.journal.toString(),
          drift: drift.drift.toString(),
        })),
      },
      "LEDGER RECONCILIATION FAILED",
    )
    return false
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.endsWith("reconcile.ts") || process.argv[1]?.endsWith("reconcile.js")) {
  runReconciliation()
    .then((healthy) => process.exit(healthy ? 0 : 1))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
