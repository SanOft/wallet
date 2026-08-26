import type { PrismaClient } from "@prisma/client"
import {
  accountsResponseSchema,
  idempotencyKeySchema,
  transferResponseSchema,
} from "@wallet/shared"
import { Router } from "express"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type { TransferResult, TransferService } from "../../../domain/TransferService.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { respond } from "../respond.js"

export interface AccountRouterDependencies {
  readonly prisma: PrismaClient
  readonly transfers: TransferService
  readonly tokens: TokenService
}

/**
 * `GET /api/accounts` and `POST /api/accounts/topup` (§12.1).
 */
export function accountRouter({ prisma, transfers, tokens }: AccountRouterDependencies): Router {
  const router = Router()

  router.get("/api/accounts", requireAuth(tokens), async (req, res) => {
    const userId = req.userId
    if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        // Only this user's own accounts, resolved through the token rather
        // than an id in the request (FR-4.5).
        accounts: { select: { id: true, currency: true, balance: true, type: true } },
      },
    })
    if (!user) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    respond(res, 200, accountsResponseSchema, {
      // §12.2, §9.3: balances leave as strings. A BigInt has no JSON form, and
      // one narrowed to a number loses precision above 2^53.
      accounts: user.accounts.map((account) => ({
        id: account.id,
        currency: account.currency,
        balance: account.balance.toString(),
        type: account.type,
      })),
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    })
  })

  /**
   * FR-10. Money-moving, so §12.2's `Idempotency-Key` rule applies: a
   * double-tapped "Demo top-up" button must not mint twice.
   */
  router.post("/api/accounts/topup", requireAuth(tokens), async (req, res) => {
    const userId = req.userId
    if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"))
    if (!key.success) {
      throw new ValidationError([{ path: ["Idempotency-Key"], code: "field.required" }])
    }

    const result = await transfers.topUp(userId, key.data)
    respond(res, 201, transferResponseSchema, toWire(result))
  })

  return router
}

/** §12.2, §9.3: amounts as strings, dates as ISO 8601 UTC. */
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
