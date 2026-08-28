import type { PrismaClient } from "@prisma/client"
import {
  historyQuerySchema,
  historyResponseSchema,
  idempotencyKeySchema,
  transferRequestSchema,
  transferResponseSchema,
} from "@wallet/shared"
import { Router } from "express"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type {
  HistoryRow,
  TransferResult,
  TransferService,
} from "../../../domain/TransferService.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireCurrentSession } from "../middleware/requireCurrentSession.js"
import { respond } from "../respond.js"

export interface TransferRouterDependencies {
  readonly transfers: TransferService
  readonly tokens: TokenService
  /** Only for `requireCurrentSession`: this router reads nothing itself. */
  readonly prisma: PrismaClient
}

/**
 * `POST /api/transfers` (§12.1).
 *
 * Parsing and formatting only. Every rule this endpoint appears to enforce —
 * limits, ownership, sufficient funds, idempotency — lives in the service, so
 * the USSD adapter enforces the identical set without sharing a line with this
 * file (§8.3).
 */
export function transferRouter({ transfers, tokens, prisma }: TransferRouterDependencies): Router {
  const router = Router()

  router.post(
    "/api/transfers",
    requireAuth(tokens),
    requireCurrentSession(prisma),
    async (req, res) => {
      // §12.2: "a request without a key gets 400". Reported as a field error so
      // the client is told *which* header, using the existing catalog rather
      // than a code invented for the occasion.
      const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"))
      if (!key.success) {
        throw new ValidationError([{ path: ["Idempotency-Key"], code: "field.required" }])
      }

      const input = transferRequestSchema.parse(req.body)

      // `requireAuth` guarantees this, but falling back to an empty string would
      // turn a middleware regression into a malformed query rather than a refusal.
      if (!req.userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

      const result = await transfers.execute({
        // Never from the body: the sender is whoever holds the token (FR-4.5).
        senderUserId: req.userId,
        recipientPhone: input.phone,
        amount: input.amount,
        idempotencyKey: key.data,
        channel: "WEB",
      })

      respond(res, 201, transferResponseSchema, toWire(result))
    },
  )

  /**
   * `GET /api/transfers` (FR-5, §12.1).
   *
   * No `requireCurrentSession` here, and the omission is deliberate rather
   * than forgotten. P-16 scoped that check to the routes where something
   * irreversible happens, because it costs a database read on every call and
   * this is one a client makes constantly. Reading one's own history with an
   * access token minted moments before a revocation discloses what that same
   * token already showed on the screen it was minted for.
   */
  router.get("/api/transfers", requireAuth(tokens), async (req, res) => {
    const query = historyQuerySchema.parse(req.query)

    if (!req.userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    const page = await transfers.history({
      // Never from the query: whose history it is, is decided by the token.
      userId: req.userId,
      cursor: query.cursor ?? null,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
      direction: query.direction ?? null,
      status: query.status ?? null,
      limit: query.limit,
    })

    respond(res, 200, historyResponseSchema, {
      items: page.rows.map(toHistoryWire),
      nextCursor: page.nextCursor,
    })
  })

  return router
}

/** §12.2, §9.3: amounts leave as strings, dates as ISO 8601 UTC. */
function toHistoryWire(row: HistoryRow) {
  return {
    ...row,
    amount: row.amount.toString(),
    createdAt: row.createdAt.toISOString(),
  }
}

/** §12.2, §9.3: amounts leave as strings, dates as ISO 8601 UTC. */
function toWire(result: TransferResult) {
  return {
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
