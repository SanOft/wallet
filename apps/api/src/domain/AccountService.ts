import type { PrismaClient } from "@prisma/client"
import { maskRecipientName } from "@wallet/shared"
import { DomainError, RecipientNotFoundError } from "./errors.js"
import { SlidingWindow } from "./SlidingWindow.js"

/**
 * §8.3's `AccountService` — balance and lookup (P-19).
 *
 * The diagram has always shown both the REST adapter and the USSD adapter
 * pointing at this box, and until now there was no box: `routes/accounts.ts`
 * and `routes/recipients.ts` queried Prisma directly, and FR-4.9's cap lived
 * in the route. That was tolerable while one channel existed. B6 added a
 * second, and the cost showed up immediately — the same twenty-per-hour rule
 * written twice, in two shapes, in two layers (P-34).
 *
 * The rule now lives here in one piece: the budget, the query it protects, and
 * the masking. A channel that wants to answer "is this number registered, and
 * who is it" cannot answer half of it.
 *
 * History is the one thing §8.3 lists that is deliberately still elsewhere. It
 * belongs to `TransferService`, which owns the rows, the cursor and the
 * ownership predicate; moving the read away from the writer would split one
 * table's rules across two services to satisfy a diagram.
 */

/** FR-4.9: twenty lookups per user per hour. One rule, both channels. */
export const LOOKUP_LIMIT = 20
export const LOOKUP_WINDOW_MS = 60 * 60 * 1000

export interface AccountRow {
  readonly id: string
  readonly currency: string
  readonly balance: bigint
  readonly type: string
}

export interface AccountOverview {
  readonly user: {
    readonly id: string
    readonly phone: string
    readonly firstName: string
    readonly lastName: string
  }
  readonly accounts: readonly AccountRow[]
}

/**
 * What a lookup discloses, and nothing more.
 *
 * The name is masked *here* rather than by each caller, so a full surname
 * never leaves the domain even if a future adapter forgets (FR-4.6). Both
 * existing callers masked it themselves and would have gone on doing so; the
 * point is that the third one cannot fail to.
 */
export interface RecipientMatch {
  readonly phone: string
  readonly maskedName: string
}

export interface AccountServiceDependencies {
  readonly prisma: PrismaClient
  /**
   * Injected so a test can move the window rather than wait an hour. Without
   * it FR-4.9's *window* — as opposed to its count — had no way to be tested,
   * and three mutations that gutted it passed the suite.
   */
  readonly now?: () => number
}

export class AccountService {
  readonly #prisma: PrismaClient
  readonly #now: () => number
  readonly #lookups = new SlidingWindow(LOOKUP_LIMIT, LOOKUP_WINDOW_MS)

  constructor({ prisma, now = () => Date.now() }: AccountServiceDependencies) {
    this.#prisma = prisma
    this.#now = now
  }

  /** `GET /api/accounts` (§12.1). Only ever this user's own rows (FR-4.5). */
  async overview(userId: string): Promise<AccountOverview | null> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        accounts: { select: { id: true, currency: true, balance: true, type: true } },
      },
    })
    if (!user) return null

    return {
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      accounts: user.accounts,
    }
  }

  /**
   * Which account belongs to a number.
   *
   * Used by the USSD adapter to turn caller ID into an account. It answers
   * "which account" and never "may they see it" — on that channel caller ID is
   * the only identity there is, and NIST 800-63B puts the PSTN in its
   * RESTRICTED class for exactly that reason (NFR-1.11, ADR-0010), so every
   * disclosure behind it is gated by the PIN as well.
   */
  async findUserIdByPhone(phone: string): Promise<string | null> {
    const user = await this.#prisma.user.findFirst({
      where: { phone, accounts: { some: { type: "USER" } } },
      select: { id: true },
    })
    return user?.id ?? null
  }

  /**
   * FR-4.9's lookup: the cap and the query it protects, together.
   *
   * The budget is spent before the query runs, so a refused caller costs a
   * counter increment and nothing else — and, more importantly, learns nothing
   * from the timing of an answer they did not get.
   *
   * @throws DomainError `RATE_LIMITED` when the caller is over budget.
   * @throws RecipientNotFoundError for an unregistered number *and* for the
   *   treasury, which are deliberately the same answer: a caller learns only
   *   that they cannot pay it.
   */
  async lookupRecipient(callerId: string, phone: string): Promise<RecipientMatch> {
    if (!this.#lookups.admit(callerId, this.#now())) {
      throw new DomainError("RATE_LIMITED", "Too many lookups")
    }

    const recipient = await this.#prisma.user.findFirst({
      // An exact match on the full number. There is no prefix search and no
      // partial match, so the endpoint cannot be walked.
      where: { phone, accounts: { some: { type: "USER" } } },
      select: { phone: true, firstName: true, lastName: true },
    })
    if (!recipient) throw new RecipientNotFoundError()

    return {
      phone: recipient.phone,
      maskedName: maskRecipientName(recipient.firstName, recipient.lastName),
    }
  }

  /** Exposed so a test starts from a known state rather than a shared one. */
  resetLookups(): void {
    this.#lookups.reset()
  }
}
