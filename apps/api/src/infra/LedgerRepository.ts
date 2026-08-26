import type { PrismaClient } from "@prisma/client"

/**
 * The ledger's only door (spec §9.5, I-3).
 *
 * I-3 asks for two things: a database rule forbidding UPDATE and DELETE — which
 * day 2's triggers provide — and "no such method exists in the repository API
 * at the code layer". The second half is what this file is.
 *
 * The client is held in a private field, so a caller cannot reach past this
 * class to `prisma.ledgerEntry.update()`. The type below narrows what may be
 * handed in, and nothing here returns a Prisma delegate. Mutation is not
 * something this module declined to implement; it is something a caller cannot
 * express through it.
 */

/** Everything a ledger write needs, and nothing that could address a row. */
export interface LedgerEntryDraft {
  readonly accountId: string
  readonly transferId: string
  /** Signed minor units. Negative debits the account, positive credits it. */
  readonly amount: bigint
  /** The account's balance immediately after this entry (§9.2). */
  readonly balanceAfter: bigint
}

/**
 * A Prisma client or an interactive transaction handle. Every method here runs
 * on whatever it is given, so the repository never opens a transaction of its
 * own — the caller decides the boundary, which for a transfer is the whole
 * double-entry pair (FR-4.3).
 */
export type LedgerClient = Pick<PrismaClient, "ledgerEntry">

export class LedgerRepository {
  readonly #client: LedgerClient

  constructor(client: LedgerClient) {
    this.#client = client
  }

  /**
   * Appends entries. Takes the whole pair at once rather than one at a time,
   * because a single entry is never a valid state to leave the ledger in — the
   * deferred constraint trigger would reject it at COMMIT anyway (I-2).
   */
  async append(entries: readonly LedgerEntryDraft[]): Promise<void> {
    await this.#client.ledgerEntry.createMany({
      data: entries.map((entry) => ({
        accountId: entry.accountId,
        transferId: entry.transferId,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
      })),
    })
  }

  /**
   * The account's balance derived from the journal, which is the definition
   * (FR-3.2). `Account.balance` is a cached snapshot of exactly this number,
   * and the daily reconciliation compares the two (I-4).
   */
  async balanceOf(accountId: string): Promise<bigint> {
    const result = await this.#client.ledgerEntry.aggregate({
      where: { accountId },
      _sum: { amount: true },
    })
    return result._sum.amount ?? 0n
  }

  /**
   * I-1 across the whole system. Should be zero, always, without exception —
   * every credit came from somewhere, including demo money, which comes from
   * the treasury (§9.4). This is what S-7 asserts after every suite.
   */
  async sumOfAllEntries(): Promise<bigint> {
    const result = await this.#client.ledgerEntry.aggregate({ _sum: { amount: true } })
    return result._sum.amount ?? 0n
  }

  /** Entries for one transfer, oldest first. Read-only, like everything here. */
  async entriesForTransfer(transferId: string): Promise<readonly LedgerEntryDraft[]> {
    const rows = await this.#client.ledgerEntry.findMany({
      where: { transferId },
      orderBy: { createdAt: "asc" },
      select: { accountId: true, transferId: true, amount: true, balanceAfter: true },
    })
    return rows
  }
}
