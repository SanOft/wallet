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

export interface ReconciliationReport {
  readonly checkedAt: Date
  /** I-1. Zero, always, without exception (§9.4). */
  readonly globalSum: bigint
  /** I-4. Empty, or the system has lost track of somebody's money. */
  readonly drifts: readonly Drift[]
}

interface DriftRow {
  readonly accountId: string
  readonly snapshot: bigint
  readonly journal: bigint
}

interface SumRow {
  readonly total: bigint | null
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

  return {
    checkedAt: new Date(),
    globalSum: total?.total ?? 0n,
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
  return report.globalSum === 0n && report.drifts.length === 0
}
