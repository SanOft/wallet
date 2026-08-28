import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  CHANNEL_LIMITS,
  DEMO_TOPUP_AMOUNT,
  DEMO_TOPUP_MAX_PER_DAY,
  DEMO_TOPUP_WINDOW_HOURS,
  type FieldIssue,
  type HistoryItem,
  maskRecipientName,
  NEW_RECIPIENT_LIMIT,
  NEW_RECIPIENT_WINDOW_HOURS,
  TRANSFER_LIMITS,
  type TransferChannel,
  type TransferDirection,
  VELOCITY_MAX_TRANSFERS,
  VELOCITY_WINDOW_MINUTES,
} from "@wallet/shared"
import { LedgerRepository } from "../infra/LedgerRepository.js"
import {
  DomainError,
  IdempotencyConflictError,
  InsufficientFundsError,
  LimitExceededError,
  RecipientNotFoundError,
  SelfTransferForbiddenError,
  ValidationError,
} from "./errors.js"

/**
 * Money transfer (FR-4), the centre of the system.
 *
 * Channel-agnostic by §8.3: plain values in, plain values out. Nothing here
 * knows about HTTP, cookies, status codes or `CON`/`END`, so the USSD adapter
 * (B6) reuses it unchanged.
 *
 * What this service does *not* guarantee on its own: that the ledger balances.
 * Day 2's deferred constraint triggers assert I-1, I-2 and I-6 at COMMIT, so a
 * bug here aborts the transaction rather than committing a lie.
 */

export interface TransferInput {
  readonly senderUserId: string
  readonly recipientPhone: string
  /** Minor units (§9.3). */
  readonly amount: bigint
  readonly idempotencyKey: string
  readonly channel: TransferChannel
  readonly type?: "P2P" | "TOPUP"
}

export interface TransferResult {
  readonly id: string
  readonly status: "COMPLETED" | "FAILED"
  readonly amount: bigint
  readonly channel: TransferChannel
  readonly type: "P2P" | "TOPUP"
  readonly createdAt: Date
  readonly completedAt: Date | null
  readonly failReason: string | null
  readonly senderBalanceAfter: bigint
}

type TransactionClient = Prisma.TransactionClient

/** FR-4.3: three attempts, then the caller sees the conflict. */
const SERIALIZABLE_RETRIES = 3

/** FR-4.4: keys are retained for 24 hours. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/** Postgres 40001, surfaced by Prisma when a `Serializable` transaction aborts. */
const SERIALIZATION_FAILURE = "P2034"
/** Postgres 23505 — here it always means another request won a race. */
const UNIQUE_VIOLATION = "P2002"

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
}

const isSerializationFailure = (error: unknown) => hasPrismaCode(error, SERIALIZATION_FAILURE)
const isUniqueViolation = (error: unknown) => hasPrismaCode(error, UNIQUE_VIOLATION)

/**
 * Exponential backoff with jitter between serialization retries.
 *
 * Three immediate retries are not a retry policy under SSI — they are three
 * coin flips inside one contention window. Measured at eight concurrent payers
 * to a single account, retrying with no pause rejected 63% of honest
 * transfers. The pause lets the winner commit and clear the way; the jitter
 * stops the losers colliding again in lockstep.
 */
function backoffMs(attempt: number): number {
  return Math.round(2 ** attempt * 5 * (0.5 + Math.random()))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Identifies the payload, so a replayed key with different contents is a 409
 * rather than a silently wrong replay (FR-4.4). The field order is fixed here
 * rather than taken from the caller's object, because `JSON.stringify` follows
 * insertion order and two equivalent requests must hash the same.
 */
export function hashTransferRequest(input: TransferInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        senderUserId: input.senderUserId,
        recipientPhone: input.recipientPhone,
        amount: input.amount.toString(),
        channel: input.channel,
        type: input.type ?? "P2P",
      }),
    )
    .digest("base64url")
}

/**
 * What a key resolves to on replay.
 *
 * Failures are stored as well as successes, because FR-4.4 says a repeated key
 * returns *the first response* and a 422 is a response. Storing a domain code
 * rather than an HTTP status keeps §8.3 intact — the adapter still owns the
 * translation.
 */
type StoredOutcome =
  | { readonly kind: "completed"; readonly result: TransferResult }
  | {
      readonly kind: "failed"
      readonly code: ApiErrorCode
      readonly message: string
      readonly details?: readonly FieldIssue[]
    }

/** FR-5's query, already parsed: the route owns the strings, this owns dates. */
export interface HistoryInput {
  readonly userId: string
  /*
   * `null` rather than optional, for every filter.
   *
   * `exactOptionalPropertyTypes` is on, so `cursor?: string` forbids passing
   * `undefined` explicitly — and the caller is a route holding parsed query
   * values that are naturally absent. The alternatives were five conditional
   * spreads at the call site or `| undefined`, which appears nowhere else in
   * this codebase. "Absent" and "explicitly nothing" mean the same thing for a
   * filter, so saying so once here is cheaper than proving it at each call.
   */
  readonly cursor: string | null
  readonly from: Date | null
  readonly to: Date | null
  readonly direction: TransferDirection | null
  readonly status: TransferResult["status"] | "PENDING" | null
  readonly limit: number
}

/**
 * A row on the way out, in domain types: `bigint` and `Date`, not strings.
 *
 * §9.3 keeps money as `bigint` everywhere inside the service; the conversion
 * to a decimal string is a wire concern and happens once, in the route. A
 * domain that returned strings would invite arithmetic on them.
 */
export interface HistoryRow extends Omit<HistoryItem, "amount" | "createdAt"> {
  readonly amount: bigint
  readonly createdAt: Date
}

export interface HistoryPage {
  readonly rows: readonly HistoryRow[]
  readonly nextCursor: string | null
}

export interface TransferServiceDependencies {
  readonly prisma: PrismaClient
  readonly now?: () => Date
}

export class TransferService {
  readonly #prisma: PrismaClient
  readonly #now: () => Date

  constructor({ prisma, now = () => new Date() }: TransferServiceDependencies) {
    this.#prisma = prisma
    this.#now = now
  }

  async execute(input: TransferInput): Promise<TransferResult> {
    const requestHash = hashTransferRequest(input)

    const replay = await this.#replay(input, requestHash)
    if (replay) return this.#settle(replay)

    let lastConflict: unknown
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt++) {
      try {
        return await this.#prisma.$transaction((tx) => this.#run(tx, input, requestHash), {
          // FR-4.3. Postgres serializable is optimistic: both transactions run
          // and one aborts at COMMIT if the pair could not have been produced
          // in some serial order. Retrying is part of the contract.
          isolationLevel: "Serializable",
        })
      } catch (error) {
        /**
         * Another request carrying this key committed while we ran. FR-4.4's
         * "a repeated key returns the first response" has to hold for a
         * *concurrent* repeat as much as a sequential one — the double tap
         * (S-6) and the outbox replay (11.6) are concurrent by nature.
         *
         * Left unmapped, this escaped as a P2002 and became `INTERNAL`, whose
         * catalogue text is "The operation was not performed" — a factual
         * claim about money, and a false one. A user who believed it and
         * re-sent with a fresh key paid twice.
         */
        if (isUniqueViolation(error)) {
          const settled = await this.#replay(input, requestHash)
          if (settled) return this.#settle(settled)
          throw new IdempotencyConflictError()
        }

        // A business rule refused it. FR-4.8 and §11.5 say that outcome is a
        // FAILED transfer, not the absence of one: history has to be able to
        // show it (FR-5.3) and the wizard has to explain it (13.5).
        if (error instanceof DomainError) {
          await this.#recordFailure(input, requestHash, error)
          throw error
        }

        if (!isSerializationFailure(error)) throw error
        lastConflict = error
        if (attempt < SERIALIZABLE_RETRIES) await sleep(backoffMs(attempt))
      }
    }

    throw lastConflict
  }

  /**
   * FR-5: one page of the caller's own history, newest first.
   *
   * In the service rather than the route, for the reason §8.3 gives and P-19
   * records as a mistake already made twice: the USSD channel will need the
   * same list, and a query written in an Express handler is a query the other
   * adapter has to write again from memory.
   *
   * Keyset pagination, not offset (§12.2). A page boundary expressed as "skip
   * 20" moves when a new transfer arrives — which, on the screen where money
   * lands, it constantly does — and the reader silently sees a row twice or
   * never. `(createdAt, id)` is a total order, so a cursor names a position
   * rather than a count.
   *
   * Two queries, one per side, merged here — not one query with an `OR`.
   *
   * The `OR` version was written first and measured: Postgres answers it with
   * a BitmapOr and then a **Sort**, and that sort covers every transfer the
   * account has ever been part of, to return twenty. The cost therefore grows
   * with one person's history rather than with the table, which is the wrong
   * thing for it to grow with — an active user is the success case, and this
   * gets slower exactly for the people who use the product most.
   *
   * Each side alone matches an index whose second column is `createdAt`, so
   * each is an ordered walk that stops after `limit + 1` rows. Merging two
   * lists of at most twenty-one rows is free, and the whole operation is
   * bounded by the page size at any history length.
   *
   * A direction filter collapses this back to one query, because there is then
   * only one side to read.
   */
  async history(input: HistoryInput): Promise<HistoryPage> {
    const accounts = await this.#prisma.account.findMany({
      where: { userId: input.userId },
      select: { id: true },
    })
    const mine = accounts.map((account) => account.id)

    // No account is not an error: a user exists before their account does in
    // exactly one window, and an empty page is the truthful answer.
    if (mine.length === 0) return { rows: [], nextCursor: null }

    const cursor = input.cursor ? decodeCursor(input.cursor) : null

    const filters: Prisma.TransferWhereInput[] = [
      ...(input.status ? [{ status: input.status }] : []),
      ...(input.from ? [{ createdAt: { gte: input.from } }] : []),
      ...(input.to ? [{ createdAt: { lte: input.to } }] : []),
      ...(cursor
        ? [
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                // The tiebreaker, and the reason two transfers in the same
                // millisecond do not hide each other at a page edge.
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ]
        : []),
    ]

    // One more than asked for, on each side: whether a next page exists is
    // answered by finding a row, not by a second COUNT over the same predicate.
    const sideOf = (side: Prisma.TransferWhereInput) =>
      this.#prisma.transfer.findMany({
        where: { AND: [side, ...filters] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: {
          id: true,
          createdAt: true,
          status: true,
          type: true,
          channel: true,
          amount: true,
          fromAccountId: true,
          fromAccount: { select: { type: true, user: PARTY } },
          toAccount: { select: { type: true, user: PARTY } },
        },
      })

    const sides: Prisma.TransferWhereInput[] =
      input.direction === "incoming"
        ? [{ toAccountId: { in: mine } }]
        : input.direction === "outgoing"
          ? [{ fromAccountId: { in: mine } }]
          : [{ fromAccountId: { in: mine } }, { toAccountId: { in: mine } }]

    const scans = await Promise.all(sides.map(sideOf))

    /*
     * Deduplicated before merging. A transfer with both accounts belonging to
     * the same person appears in both scans, and while nothing can create one
     * today — self-transfer is refused, and a top-up has the treasury on one
     * side — a page that showed it twice would be a strange bug to diagnose
     * later from a screenshot.
     */
    const unique = new Map(scans.flat().map((transfer) => [transfer.id, transfer]))

    const found = [...unique.values()]
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime()
        // Falls back to the id for the same reason the cursor does. String
        // order over canonical lowercase uuids matches Postgres's byte order,
        // so the merge agrees with the scans it merges.
        return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
      .slice(0, input.limit + 1)

    const page = found.slice(0, input.limit)
    const last = page.at(-1)

    return {
      rows: page.map((transfer) => {
        const outgoing = mine.includes(transfer.fromAccountId)
        const other = outgoing ? transfer.toAccount : transfer.fromAccount

        return {
          id: transfer.id,
          createdAt: transfer.createdAt,
          status: transfer.status,
          type: transfer.type,
          channel: transfer.channel,
          direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
          amount: transfer.amount,
          /*
           * Keyed on the account being the treasury rather than on the
           * transfer being a TOPUP: the two agree today, and if they ever stop
           * agreeing it is the account that decides whether there is a person
           * on the other side to name.
           */
          counterparty:
            other.type === "TREASURY"
              ? null
              : { maskedName: maskRecipientName(other.user.firstName, other.user.lastName) },
        }
      }),
      nextCursor: found.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    }
  }

  /** Turns a stored outcome back into a return value or the original refusal. */
  #settle(outcome: StoredOutcome): TransferResult {
    if (outcome.kind === "completed") return outcome.result
    throw new DomainError(outcome.code, outcome.message, outcome.details)
  }

  async #replay(input: TransferInput, requestHash: string): Promise<StoredOutcome | null> {
    const record = await this.#prisma.idempotencyRecord.findUnique({
      // Scoped by user (P-8). Looking the key up on its own put every client
      // in one namespace, so one of them could occupy a value another was
      // about to use.
      where: { userId_key: { userId: input.senderUserId, key: input.idempotencyKey } },
      select: { userId: true, requestHash: true, response: true, expiresAt: true },
    })

    if (!record) return null

    if (record.expiresAt <= this.#now()) {
      /**
       * FR-4.4 retains keys for 24 hours. Skipping an expired record without
       * removing it left the primary key occupied, so the next use of that key
       * collided forever — "retained for 24 hours" became "poisoned after 24
       * hours". Deleting it here is the sweep, done at the only moment it
       * matters. A FAILED transfer holding the same key goes with it; a
       * COMPLETED one is never removed, because the ledger references it.
       */
      await this.#prisma.$transaction([
        this.#prisma.idempotencyRecord.deleteMany({
          where: {
            userId: input.senderUserId,
            key: input.idempotencyKey,
            expiresAt: { lte: this.#now() },
          },
        }),
        this.#prisma.transfer.deleteMany({
          where: {
            initiatedBy: input.senderUserId,
            idempotencyKey: input.idempotencyKey,
            status: "FAILED",
          },
        }),
      ])
      return null
    }

    // A key belonging to another user is a collision, not a replay. Answering
    // with their stored outcome would hand one user another's transfer.
    if (record.userId !== input.senderUserId || record.requestHash !== requestHash) {
      throw new IdempotencyConflictError()
    }

    return parseOutcome(record.response)
  }

  async #run(
    tx: TransactionClient,
    input: TransferInput,
    requestHash: string,
  ): Promise<TransferResult> {
    const now = this.#now()
    const type = input.type ?? "P2P"

    // FR-4.5 / S-3: the sender account is resolved *through* the authenticated
    // user. There is no query in this method that could address an account the
    // caller does not own — an id in the request has nowhere to go.
    const sender = await tx.account.findFirst({
      where: { userId: input.senderUserId, currency: "UZS", type: "USER" },
      select: { id: true, balance: true },
    })
    if (!sender) throw new RecipientNotFoundError()

    const recipient = await tx.account.findFirst({
      // `type: "USER"` matters. The treasury has a phone that satisfies both
      // the E.164 CHECK and the regional schema, so without this a user could
      // pay money *into* the mint, where no code path can spend it — and
      // `-treasury.balance`, the only measure of demo money issued (§9.4),
      // would quietly stop meaning that.
      where: { user: { phone: input.recipientPhone }, currency: "UZS", type: "USER" },
      select: { id: true, balance: true },
    })
    // Deliberately the same error as "you have no account": paying a number
    // must not reveal whether it is registered (FR-4.9).
    if (!recipient) throw new RecipientNotFoundError()

    if (recipient.id === sender.id) throw new SelfTransferForbiddenError()

    this.#assertAmountIsSane(input.amount)
    await this.#assertWithinLimits(tx, sender.id, recipient.id, input, now)

    if (sender.balance < input.amount) throw new InsufficientFundsError()

    return this.#moveMoney(tx, {
      from: sender,
      to: recipient,
      input,
      type,
      requestHash,
      now,
    })
  }

  /**
   * Writes one transfer and its ledger pair. Shared by P2P and TOPUP, so a demo
   * top-up is an ordinary transfer from the treasury and nothing about
   * double-entry is special-cased for it (FR-10.2).
   */
  async #moveMoney(
    tx: TransactionClient,
    move: {
      readonly from: { readonly id: string; readonly balance: bigint }
      readonly to: { readonly id: string; readonly balance: bigint }
      readonly input: TransferInput
      readonly type: "P2P" | "TOPUP"
      readonly requestHash: string
      readonly now: Date
    },
  ): Promise<TransferResult> {
    const { from, to, input, type, requestHash, now } = move

    const senderBalanceAfter = from.balance - input.amount
    const recipientBalanceAfter = to.balance + input.amount

    // PENDING, then the entries, then COMPLETED — the order §11.4 draws. The
    // deferred trigger checks the whole shape at COMMIT, so a transfer that
    // never reaches COMPLETED, or reaches it without its pair, aborts.
    const transfer = await tx.transfer.create({
      data: {
        fromAccountId: from.id,
        toAccountId: to.id,
        // Who asked, which is not derivable from the accounts: a top-up leaves
        // the treasury, so its sender is nobody's account.
        initiatedBy: input.senderUserId,
        amount: input.amount,
        type,
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
      },
      select: { id: true, createdAt: true },
    })

    await new LedgerRepository(tx).append([
      {
        accountId: from.id,
        transferId: transfer.id,
        amount: -input.amount,
        balanceAfter: senderBalanceAfter,
      },
      {
        accountId: to.id,
        transferId: transfer.id,
        amount: input.amount,
        balanceAfter: recipientBalanceAfter,
      },
    ])

    // The snapshot (FR-3.2, I-4). The ledger is the truth; this is the cached
    // answer, and reconciliation compares the two.
    await tx.account.update({ where: { id: from.id }, data: { balance: senderBalanceAfter } })
    await tx.account.update({ where: { id: to.id }, data: { balance: recipientBalanceAfter } })

    const completed = await tx.transfer.update({
      where: { id: transfer.id },
      data: { status: "COMPLETED", completedAt: now },
      select: { id: true, amount: true, createdAt: true, completedAt: true },
    })

    const result: TransferResult = {
      id: completed.id,
      status: "COMPLETED",
      amount: completed.amount,
      channel: input.channel,
      type,
      createdAt: completed.createdAt,
      completedAt: completed.completedAt ?? now,
      failReason: null,
      senderBalanceAfter,
    }

    // Inside the transaction, so a crash cannot leave a stored response for a
    // transfer that never happened.
    await tx.idempotencyRecord.create({
      data: {
        key: input.idempotencyKey,
        userId: input.senderUserId,
        requestHash,
        response: serialiseOutcome({ kind: "completed", result }),
        // §9.1 defines this column as an HTTP status, and an idempotency
        // record is a REST-replay concept by construction, so the spec's own
        // data model wins over §8.3 purity here. It is the same compromise
        // `errors.ts` documents for `ApiErrorCode`, and the database CHECK
        // (100..599) enforces it either way.
        statusCode: 201,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    })

    return result
  }

  /**
   * Demo top-up (FR-10).
   *
   * Deliberately the same machinery as a P2P transfer: the treasury is the
   * sender, the ledger pair is written the same way, and `sum(ledger) = 0`
   * holds because the money comes from the mint rather than from nowhere
   * (§9.4). If this had its own write path, the invariant would depend on two
   * implementations agreeing forever.
   *
   * The FR-6 limits do not apply — they govern what a *user* may send, and the
   * treasury is not a user. FR-10.3's three-per-day cap is what governs this.
   */
  async topUp(userId: string, idempotencyKey: string): Promise<TransferResult> {
    const input: TransferInput = {
      senderUserId: userId,
      recipientPhone: "",
      amount: DEMO_TOPUP_AMOUNT,
      idempotencyKey,
      channel: "WEB",
      type: "TOPUP",
    }
    const requestHash = hashTransferRequest(input)

    const replay = await this.#replay(input, requestHash)
    if (replay) return this.#settle(replay)

    let lastConflict: unknown
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt++) {
      try {
        return await this.#prisma.$transaction(
          async (tx) => {
            const now = this.#now()

            /**
             * Every top-up in the system debits the same treasury row, which
             * under Serializable makes it a global conflict point rather than
             * a hot row: twelve different users each doing their first-ever
             * top-up concurrently saw eight of them abort with P2034 and
             * surface as INTERNAL. The retry ladder was tuned for P2P, where
             * the contended account is one recipient among many; here it is
             * every request.
             *
             * A transaction-scoped advisory lock turns that into a queue.
             * Callers wait for their turn and then commit, instead of racing,
             * losing, and being told the technical failure is theirs. It is
             * released automatically at COMMIT or ROLLBACK, so a crash cannot
             * strand it.
             */
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wallet:treasury'))`

            const treasury = await tx.account.findFirst({
              where: { type: "TREASURY", currency: "UZS" },
              select: { id: true, balance: true },
            })
            const account = await tx.account.findFirst({
              where: { userId, currency: "UZS", type: "USER" },
              select: { id: true, balance: true },
            })
            // No treasury means the seed never ran; that is an operator fault,
            // not something to report as a user error.
            if (!treasury) throw new Error("treasury account is missing; run the seed")
            if (!account) throw new RecipientNotFoundError()

            // FR-10.3. Counts COMPLETED top-ups only: a refused one moved
            // nothing and must not spend an allowance.
            const recent = await tx.transfer.count({
              where: {
                toAccountId: account.id,
                type: "TOPUP",
                status: "COMPLETED",
                createdAt: {
                  gte: new Date(now.getTime() - DEMO_TOPUP_WINDOW_HOURS * 60 * 60 * 1000),
                },
              },
            })
            if (recent >= DEMO_TOPUP_MAX_PER_DAY) {
              throw new LimitExceededError([{ path: ["topup"], code: "limit.daily" }])
            }

            return this.#moveMoney(tx, {
              from: treasury,
              to: account,
              input,
              type: "TOPUP",
              requestHash,
              now,
            })
          },
          /**
           * Read Committed, deliberately, and it is not a weakening.
           *
           * The advisory lock above is mutual exclusion: only one top-up runs
           * at a time, so there is no concurrent writer for an isolation level
           * to protect against. Serializable here was strictly worse — its
           * snapshot is taken when the transaction's first statement runs,
           * which is *before* the lock is granted, so every queued caller woke
           * with a stale snapshot and was aborted by SSI at COMMIT. The lock
           * and the optimistic detector do not compose.
           *
           * What FR-4.3's Serializable requirement protects is two transfers
           * racing on one user's balance. That race cannot arise on this path:
           * the treasury is allowed to go negative (§9.4), so there is no
           * balance constraint to lose, and the writer is serialized anyway.
           * The ledger invariants are enforced by the deferred triggers, which
           * are isolation-independent.
           */
          { isolationLevel: "ReadCommitted" },
        )
      } catch (error) {
        if (isUniqueViolation(error)) {
          const settled = await this.#replay(input, requestHash)
          if (settled) return this.#settle(settled)
          throw new IdempotencyConflictError()
        }
        // The same treatment `execute` gives a refusal, and for the same
        // reasons. Leaving it out meant a refused top-up wrote no FAILED row
        // (FR-4.8), stored no outcome (FR-4.4), and left the key live — so the
        // very same key minted a fresh 1 000 000 UZS a day later, which §12.2
        // says is a 409.
        if (error instanceof DomainError) {
          await this.#recordFailure(input, requestHash, error)
          throw error
        }
        if (!isSerializationFailure(error)) throw error
        lastConflict = error
        if (attempt < SERIALIZABLE_RETRIES) await sleep(backoffMs(attempt))
      }
    }

    throw lastConflict
  }

  /**
   * Records a refused transfer as a FAILED row (§11.5, FR-4.8).
   *
   * In its own transaction, because the one that raised the error has already
   * rolled back. Best-effort: if the write itself fails — most likely because
   * a concurrent request already claimed the key — the caller still gets the
   * original refusal, which is the honest answer either way.
   */
  async #recordFailure(
    input: TransferInput,
    requestHash: string,
    error: DomainError,
  ): Promise<void> {
    const now = this.#now()

    try {
      await this.#prisma.$transaction(async (tx) => {
        // A top-up runs treasury -> caller, so its parties are the mirror of a
        // P2P's and `recipientPhone` is empty. Resolving them the same way
        // would silently record nothing.
        const isTopUp = (input.type ?? "P2P") === "TOPUP"

        const own = await tx.account.findFirst({
          where: { userId: input.senderUserId, currency: "UZS", type: "USER" },
          select: { id: true },
        })
        const treasury = isTopUp
          ? await tx.account.findFirst({
              where: { type: "TREASURY", currency: "UZS" },
              select: { id: true },
            })
          : null
        const counterparty = isTopUp
          ? own
          : await tx.account.findFirst({
              where: { user: { phone: input.recipientPhone }, currency: "UZS", type: "USER" },
              select: { id: true },
            })

        const sender = isTopUp ? treasury : own
        const recipient = counterparty
        // Nothing to attribute the attempt to. A refusal we cannot place in
        // anyone's history is better dropped than invented.
        if (!sender || !recipient || sender.id === recipient.id) return

        await tx.transfer.create({
          data: {
            fromAccountId: sender.id,
            toAccountId: recipient.id,
            initiatedBy: input.senderUserId,
            amount: input.amount,
            type: input.type ?? "P2P",
            channel: input.channel,
            idempotencyKey: input.idempotencyKey,
            status: "FAILED",
            failReason: error.code,
          },
        })

        await tx.idempotencyRecord.create({
          data: {
            key: input.idempotencyKey,
            userId: input.senderUserId,
            requestHash,
            response: serialiseOutcome({
              kind: "failed",
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            }),
            statusCode: API_ERROR_STATUS[error.code],
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        })
      })
    } catch {
      // Deliberately swallowed; see the docblock.
    }
  }

  /** FR-4.7, checked here as well because the database CHECK is the last resort. */
  #assertAmountIsSane(amount: bigint): void {
    const { min, max, step } = TRANSFER_LIMITS.UZS

    if (amount < min) {
      throw new ValidationError([{ path: ["amount"], code: "money.below_minimum" }])
    }
    if (amount > max) {
      throw new ValidationError([{ path: ["amount"], code: "money.above_maximum" }])
    }
    if (amount % step !== 0n) {
      throw new ValidationError([{ path: ["amount"], code: "money.invalid_step" }])
    }
  }

  /**
   * FR-6.1, FR-6.2 and FR-6.3.
   *
   * Each is an aggregate over a time window, asked of the database rather than
   * answered by loading rows and summing here: the index returns one number
   * instead of shipping a day of history over the wire to add it up locally.
   */
  async #assertWithinLimits(
    tx: TransactionClient,
    senderAccountId: string,
    recipientAccountId: string,
    input: TransferInput,
    now: Date,
  ): Promise<void> {
    const limits = CHANNEL_LIMITS[input.channel]

    if (input.amount > limits.perOperation) {
      throw new LimitExceededError([{ path: ["amount"], code: "limit.per_operation" }])
    }

    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // FR-6.1, daily. Only COMPLETED transfers count — a refused attempt moved
    // no money and must not consume someone's allowance.
    const spentToday = await tx.transfer.aggregate({
      where: {
        fromAccountId: senderAccountId,
        channel: input.channel,
        status: "COMPLETED",
        createdAt: { gte: dayAgo },
      },
      _sum: { amount: true },
    })
    if ((spentToday._sum.amount ?? 0n) + input.amount > limits.daily) {
      throw new LimitExceededError([{ path: ["amount"], code: "limit.daily" }])
    }

    const windowStart = new Date(now.getTime() - NEW_RECIPIENT_WINDOW_HOURS * 60 * 60 * 1000)

    const olderRelationship = await tx.transfer.findFirst({
      where: {
        fromAccountId: senderAccountId,
        toAccountId: recipientAccountId,
        status: "COMPLETED",
        createdAt: { lt: windowStart },
      },
      select: { id: true },
    })

    if (!olderRelationship) {
      /**
       * FR-6.2 caps the *total* sent to a new recipient in 24 hours, not each
       * transfer. Capping per transfer left the real ceiling at the daily
       * limit — 30 000 000 UZS instead of 500 000, sixty times the clause — on
       * the one control §17.2 names as the defence against an account-takeover
       * drain. Four transfers of exactly the cap went straight through.
       */
      const alreadySent = await tx.transfer.aggregate({
        where: {
          fromAccountId: senderAccountId,
          toAccountId: recipientAccountId,
          status: "COMPLETED",
          createdAt: { gte: windowStart },
        },
        _sum: { amount: true },
      })

      if ((alreadySent._sum.amount ?? 0n) + input.amount > NEW_RECIPIENT_LIMIT) {
        throw new LimitExceededError([{ path: ["amount"], code: "limit.new_recipient" }])
      }
    }

    // FR-6.3: velocity. Counts attempts regardless of outcome — a burst of
    // failures is the same signal as a burst of successes, which is why
    // refusals are recorded as FAILED rows rather than left as nothing.
    const recentCount = await tx.transfer.count({
      where: {
        fromAccountId: senderAccountId,
        createdAt: { gte: new Date(now.getTime() - VELOCITY_WINDOW_MINUTES * 60 * 1000) },
      },
    })
    if (recentCount >= VELOCITY_MAX_TRANSFERS) {
      throw new LimitExceededError([{ path: ["amount"], code: "limit.velocity" }])
    }
  }
}

/** BigInt has no JSON representation, so amounts are stored as strings (§9.3). */
function serialiseOutcome(outcome: StoredOutcome): Prisma.InputJsonValue {
  if (outcome.kind === "failed") {
    return {
      kind: "failed",
      code: outcome.code,
      message: outcome.message,
      ...(outcome.details ? { details: outcome.details.map((issue) => ({ ...issue })) } : {}),
    }
  }

  const { result } = outcome
  return {
    kind: "completed",
    id: result.id,
    status: result.status,
    amount: result.amount.toString(),
    channel: result.channel,
    type: result.type,
    createdAt: result.createdAt.toISOString(),
    completedAt: result.completedAt?.toISOString() ?? null,
    failReason: result.failReason,
    senderBalanceAfter: result.senderBalanceAfter.toString(),
  }
}

/**
 * Parsed, not cast. The stored value is the answer to "did my money move?",
 * and `respond.ts` argues a response must be validated against its contract —
 * the replay path is where that matters most. A record of an unrecognised
 * shape is treated as no record rather than becoming a COMPLETED transfer of
 * zero with an empty id.
 */
function parseOutcome(stored: Prisma.JsonValue): StoredOutcome | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null
  const value = stored as Record<string, unknown>

  if (value.kind === "failed") {
    return typeof value.code === "string" && typeof value.message === "string"
      ? {
          kind: "failed",
          code: value.code as ApiErrorCode,
          message: value.message,
          ...(Array.isArray(value.details) ? { details: value.details as FieldIssue[] } : {}),
        }
      : null
  }

  const required = ["id", "amount", "channel", "type", "createdAt", "senderBalanceAfter"]
  if (required.some((key) => typeof value[key] !== "string")) return null

  return {
    kind: "completed",
    result: {
      id: value.id as string,
      status: value.status === "FAILED" ? "FAILED" : "COMPLETED",
      amount: BigInt(value.amount as string),
      channel: value.channel as TransferChannel,
      type: value.type as "P2P" | "TOPUP",
      createdAt: new Date(value.createdAt as string),
      completedAt: typeof value.completedAt === "string" ? new Date(value.completedAt) : null,
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      senderBalanceAfter: BigInt(value.senderBalanceAfter as string),
    },
  }
}

/** The counterparty fields, named once so both sides of a transfer agree. */
const PARTY = { select: { firstName: true, lastName: true } } as const

/**
 * A page position, encoded so it cannot be read as an invitation to edit it.
 *
 * base64url rather than JSON: not secrecy — the contents are two values the
 * caller already has — but a token that looks like a token is returned
 * unchanged, while `{"createdAt":...}` gets parsed, adjusted, and sent back as
 * something the server never issued.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url")
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const invalid = new ValidationError([{ path: ["cursor"], code: "cursor.invalid" }])

  const [timestamp, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|")
  // `rest` matters: an id containing the separator would otherwise be silently
  // truncated into a different, valid-looking position.
  if (!timestamp || !id || rest.length > 0) throw invalid

  const createdAt = new Date(timestamp)
  if (Number.isNaN(createdAt.getTime())) throw invalid

  return { createdAt, id }
}
