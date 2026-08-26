import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import {
  CHANNEL_LIMITS,
  NEW_RECIPIENT_LIMIT,
  NEW_RECIPIENT_WINDOW_HOURS,
  TRANSFER_LIMITS,
  type TransferChannel,
  VELOCITY_MAX_TRANSFERS,
  VELOCITY_WINDOW_MINUTES,
} from "@wallet/shared"
import { LedgerRepository } from "../infra/LedgerRepository.js"
import {
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
 * Channel-agnostic by §8.3: it takes plain values and returns plain values, so
 * the USSD adapter (B6) reuses it without a line changing here. Nothing in this
 * file knows about HTTP, cookies, or `CON`/`END`.
 *
 * What this service does *not* guarantee on its own: that the ledger balances.
 * Day 2's deferred constraint triggers assert I-1, I-2 and I-6 at COMMIT, so a
 * bug here aborts the transaction instead of committing a lie. The code below
 * is written to satisfy a guarantee that already exists, which is a different
 * and much safer job than being the guarantee.
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
  readonly status: "COMPLETED"
  readonly amount: bigint
  readonly channel: TransferChannel
  readonly type: "P2P" | "TOPUP"
  readonly createdAt: Date
  readonly completedAt: Date
  readonly senderBalanceAfter: bigint
}

type TransactionClient = Prisma.TransactionClient

/** FR-4.3: three attempts, then the caller sees the conflict. */
const SERIALIZABLE_RETRIES = 3

/** FR-4.4: keys are retained for 24 hours. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Prisma's code for "Transaction failed due to a write conflict or a deadlock",
 * which is what a `Serializable` abort surfaces as (Postgres 40001).
 */
const SERIALIZATION_FAILURE = "P2034"

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SERIALIZATION_FAILURE
  )
}

/**
 * Identifies the payload, so a replayed key with different contents is a 409
 * rather than a silently wrong replay (FR-4.4). Field order is fixed here
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

  /**
   * FR-4 end to end. Retries only on a serialization conflict; every other
   * failure is the caller's answer.
   */
  async execute(input: TransferInput): Promise<TransferResult> {
    const requestHash = hashTransferRequest(input)

    // Checked before the transaction as a fast path. The authoritative check is
    // the unique primary key inside it — two requests with one key arriving
    // together both miss here, and exactly one survives the insert.
    const replay = await this.#findReplay(input, requestHash)
    if (replay) return replay

    let lastConflict: unknown
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt++) {
      try {
        return await this.#prisma.$transaction((tx) => this.#run(tx, input, requestHash), {
          // FR-4.3. Postgres serializable is optimistic: both transactions run
          // and one is aborted at COMMIT if the pair could not have been
          // produced by running them in some order. Retrying is part of the
          // contract, not error handling.
          isolationLevel: "Serializable",
        })
      } catch (error) {
        if (!isSerializationFailure(error)) throw error
        lastConflict = error
      }
    }

    throw lastConflict
  }

  /** FR-4.4: an exact replay returns the first answer; a different payload is a 409. */
  async #findReplay(input: TransferInput, requestHash: string): Promise<TransferResult | null> {
    const record = await this.#prisma.idempotencyRecord.findUnique({
      where: { key: input.idempotencyKey },
      select: { userId: true, requestHash: true, response: true, expiresAt: true },
    })

    if (!record) return null
    if (record.expiresAt <= this.#now()) return null

    // A key belonging to another user is a collision, not a replay. Answering
    // with their stored response would hand one user another's transfer.
    if (record.userId !== input.senderUserId || record.requestHash !== requestHash) {
      throw new IdempotencyConflictError()
    }

    return deserialiseResult(record.response)
  }

  async #run(
    tx: TransactionClient,
    input: TransferInput,
    requestHash: string,
  ): Promise<TransferResult> {
    const now = this.#now()
    const type = input.type ?? "P2P"

    // FR-4.5 / S-3: the sender account is located *through* the authenticated
    // user, never by an id the caller supplies. There is no query in this
    // method that could address an account the caller does not own.
    const sender = await tx.account.findFirst({
      where: { userId: input.senderUserId, currency: "UZS" },
      select: { id: true, balance: true, userId: true },
    })
    if (!sender) throw new RecipientNotFoundError()

    const recipient = await tx.account.findFirst({
      where: { user: { phone: input.recipientPhone }, currency: "UZS" },
      select: { id: true, balance: true, userId: true },
    })
    // Deliberately the same error as "you have no account": a caller must not
    // learn which numbers are registered by trying to pay them (FR-4.9).
    if (!recipient) throw new RecipientNotFoundError()

    if (recipient.id === sender.id) throw new SelfTransferForbiddenError()

    this.#assertAmountIsSane(input.amount)
    await this.#assertWithinLimits(tx, sender.id, recipient.id, input, now)

    if (sender.balance < input.amount) throw new InsufficientFundsError()

    const senderBalanceAfter = sender.balance - input.amount
    const recipientBalanceAfter = recipient.balance + input.amount

    // PENDING first, then the entries, then COMPLETED — the order §11.4 draws.
    // The deferred trigger checks the whole shape at COMMIT, so a transfer that
    // never reaches COMPLETED, or reaches it without its pair, aborts.
    const transfer = await tx.transfer.create({
      data: {
        fromAccountId: sender.id,
        toAccountId: recipient.id,
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
        accountId: sender.id,
        transferId: transfer.id,
        amount: -input.amount,
        balanceAfter: senderBalanceAfter,
      },
      {
        accountId: recipient.id,
        transferId: transfer.id,
        amount: input.amount,
        balanceAfter: recipientBalanceAfter,
      },
    ])

    // The snapshot (FR-3.2, I-4). The ledger is the truth; this is the cached
    // answer, and reconciliation compares the two.
    await tx.account.update({ where: { id: sender.id }, data: { balance: senderBalanceAfter } })
    await tx.account.update({
      where: { id: recipient.id },
      data: { balance: recipientBalanceAfter },
    })

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
      senderBalanceAfter,
    }

    // Inside the transaction, so a crash cannot leave a stored response for a
    // transfer that never happened. The primary key is what makes two
    // simultaneous requests with one key resolve to a single transfer.
    await tx.idempotencyRecord.create({
      data: {
        key: input.idempotencyKey,
        userId: input.senderUserId,
        requestHash,
        response: serialiseResult(result),
        statusCode: 201,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    })

    return result
  }

  /** FR-4.7, enforced again here because the database CHECK is the last resort. */
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

    // FR-6.1, per operation.
    if (input.amount > limits.perOperation) {
      throw new LimitExceededError([{ path: ["amount"], code: "limit.per_operation" }])
    }

    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // FR-6.1, daily. Only COMPLETED transfers count — a failed attempt did not
    // move money and must not consume someone's allowance.
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

    // FR-6.2: a recipient first paid less than 24 hours ago is "new". The
    // window is what makes this a fraud control rather than a permanent cap —
    // a thief who has just taken over an account cannot drain it in one go.
    const olderRelationship = await tx.transfer.findFirst({
      where: {
        fromAccountId: senderAccountId,
        toAccountId: recipientAccountId,
        status: "COMPLETED",
        createdAt: {
          lt: new Date(now.getTime() - NEW_RECIPIENT_WINDOW_HOURS * 60 * 60 * 1000),
        },
      },
      select: { id: true },
    })
    if (!olderRelationship && input.amount > NEW_RECIPIENT_LIMIT) {
      throw new LimitExceededError([{ path: ["amount"], code: "limit.new_recipient" }])
    }

    // FR-6.3: velocity. Counts attempts in the window regardless of outcome —
    // a burst of failures is the same signal as a burst of successes.
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
function serialiseResult(result: TransferResult): Prisma.InputJsonValue {
  return {
    id: result.id,
    status: result.status,
    amount: result.amount.toString(),
    channel: result.channel,
    type: result.type,
    createdAt: result.createdAt.toISOString(),
    completedAt: result.completedAt.toISOString(),
    senderBalanceAfter: result.senderBalanceAfter.toString(),
  }
}

function deserialiseResult(stored: Prisma.JsonValue): TransferResult {
  const value = stored as Record<string, string>
  return {
    id: value.id ?? "",
    status: "COMPLETED",
    amount: BigInt(value.amount ?? "0"),
    channel: (value.channel ?? "WEB") as TransferChannel,
    type: (value.type ?? "P2P") as "P2P" | "TOPUP",
    createdAt: new Date(value.createdAt ?? 0),
    completedAt: new Date(value.completedAt ?? 0),
    senderBalanceAfter: BigInt(value.senderBalanceAfter ?? "0"),
  }
}
