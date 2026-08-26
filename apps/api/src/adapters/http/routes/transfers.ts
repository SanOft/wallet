import { idempotencyKeySchema, transferRequestSchema, transferResponseSchema } from "@wallet/shared"
import { Router } from "express"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type { TransferResult, TransferService } from "../../../domain/TransferService.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { respond } from "../respond.js"

export interface TransferRouterDependencies {
  readonly transfers: TransferService
  readonly tokens: TokenService
}

/**
 * `POST /api/transfers` (§12.1).
 *
 * Parsing and formatting only. Every rule this endpoint appears to enforce —
 * limits, ownership, sufficient funds, idempotency — lives in the service, so
 * the USSD adapter enforces the identical set without sharing a line with this
 * file (§8.3).
 */
export function transferRouter({ transfers, tokens }: TransferRouterDependencies): Router {
  const router = Router()

  router.post("/api/transfers", requireAuth(tokens), async (req, res) => {
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
  })

  return router
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
