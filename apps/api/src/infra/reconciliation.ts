import type { PrismaClient } from "@prisma/client"

/**
 * Daily reconciliation (§20.4, invariant I-4).
 *
 * `Account.balance` is a cached snapshot; the ledger is the truth (FR-3.2).
 * Nothing keeps them in step except the transfer transaction writing both, so
 * the only way to know they still agree is to ask.
 *
 * Written as raw SQL rather than through the ORM on purpose. The question is
 * "which accounts disagree with the sum of their own entries", which is one
 * `LEFT JOIN`, one `GROUP BY` and one `HAVING` — a single indexed pass that
 * returns only the rows that are wrong. The ORM equivalent is to load every
 * account, then every entry, and compare them in TypeScript: the same answer
 * after moving the whole ledger over the wire.
 */

export interface Drift {
  readonly accountId: string
  readonly snapshot: bigint
  readonly journal: bigint
  readonly drift: bigint
}

/** One entry whose `balanceAfter` is not its account's running total (P-21). */
export interface ChainBreak {
  readonly entryId: string
  readonly accountId: string
  readonly claimed: bigint
  readonly actual: bigint
}

export interface ReconciliationReport {
  readonly checkedAt: Date
  /** I-1. Zero, always, without exception (§9.4). */
  readonly globalSum: bigint
  /** I-4. Empty, or the system has lost track of somebody's money. */
  readonly drifts: readonly Drift[]
  /**
   * P-21. Empty, or the audit trail §9.2 promises cannot be trusted.
   *
   * Since the COMMIT-time check exists, a break here can only come from a row
   * written before that migration or from something that bypassed the trigger
   * — which is precisely the pair of cases a daily job is still for. It was
   * the third thing that validated `balanceAfter` at all, and it did not.
   */
  readonly chainBreaks: readonly ChainBreak[]
}

interface DriftRow {
  readonly accountId: string
  readonly snapshot: bigint
  readonly journal: bigint
}

interface SumRow {
  readonly total: bigint | null
}

interface ChainRow {
  readonly entryId: string
  readonly accountId: string
  readonly claimed: bigint
  readonly actual: bigint
}

export async function reconcile(prisma: PrismaClient): Promise<ReconciliationReport> {
  /**
   * `LEFT JOIN`, not `JOIN`: an account with no entries yet still has to be
   * checked, and an inner join would silently drop it — which is exactly the
   * account a snapshot bug would show up on first.
   *
   * `HAVING` rather than `WHERE`, because the comparison is against an
   * aggregate, and `WHERE` is evaluated before grouping.
   */
  const drifts = await prisma.$queryRaw<DriftRow[]>`
    -- The ::bigint casts are load-bearing. SUM() over a bigint column returns
    -- numeric in Postgres, which the driver hands back as a Decimal rather
    -- than a BigInt, and mixing the two throws at the first subtraction.
    SELECT a."id"                                       AS "accountId",
           a."balance"::bigint                          AS "snapshot",
           COALESCE(SUM(le."amount"), 0)::bigint        AS "journal"
      FROM "accounts" a
      LEFT JOIN "ledger_entries" le ON le."accountId" = a."id"
     GROUP BY a."id", a."balance"
    HAVING a."balance" <> COALESCE(SUM(le."amount"), 0)
     ORDER BY ABS(a."balance" - COALESCE(SUM(le."amount"), 0)) DESC
  `

  const [total] = await prisma.$queryRaw<SumRow[]>`
    SELECT COALESCE(SUM("amount"), 0)::bigint AS "total" FROM "ledger_entries"
  `

  /**
   * Ordered by `seq`, not by `createdAt`, and the difference is the whole
   * reason the column exists: `createdAt` defaults to the transaction
   * timestamp, so every entry one transaction wrote shares it and the window
   * function would order them arbitrarily — reporting breaks that are not
   * there, which is worse than reporting none.
   */
  const chainBreaks = await prisma.$queryRaw<ChainRow[]>`
    WITH running AS (
      SELECT "id", "accountId", "balanceAfter",
             SUM("amount") OVER (PARTITION BY "accountId" ORDER BY "seq"
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint
               AS "total"
        FROM "ledger_entries"
    )
    SELECT "id"            AS "entryId",
           "accountId"     AS "accountId",
           "balanceAfter"::bigint AS "claimed",
           "total"         AS "actual"
      FROM running
     WHERE "balanceAfter" <> "total"
     ORDER BY "accountId", "entryId"
  `

  return {
    checkedAt: new Date(),
    globalSum: total?.total ?? 0n,
    chainBreaks,
    drifts: drifts.map((row) => ({
      accountId: row.accountId,
      snapshot: row.snapshot,
      journal: row.journal,
      drift: row.snapshot - row.journal,
    })),
  }
}

/**
 * §20.4: "any discrepancy is logged at level `fatal` (this must never happen)".
 *
 * `fatal` is the right level precisely because it is not actionable by a
 * retry. A drift means the two records of the same money disagree, and no
 * amount of waiting resolves that — somebody has to look.
 */
export function isHealthy(report: ReconciliationReport): boolean {
  /*
   * A chain break counts as unhealthy even though no balance is wrong when it
   * happens. §9.2 sells `balanceAfter` as making an audit O(1), and an audit
   * column that lies is worse than one that does not exist — the reconciliation
   * built on it would be reading from the source it is meant to police.
   */
  return report.globalSum === 0n && report.drifts.length === 0 && report.chainBreaks.length === 0
}
