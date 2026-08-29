import type { PrismaClient } from "@prisma/client"
import {
  accountsResponseSchema,
  CHANNEL_LIMITS,
  idempotencyKeySchema,
  topUpRequestSchema,
  transferResponseSchema,
} from "@wallet/shared"
import { Router } from "express"
import type { AccountService } from "../../../domain/AccountService.js"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type { TransferResult, TransferService } from "../../../domain/TransferService.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireCurrentSession } from "../middleware/requireCurrentSession.js"
import { respond } from "../respond.js"

export interface AccountRouterDependencies {
  readonly prisma: PrismaClient
  readonly accounts: AccountService
  readonly transfers: TransferService
  readonly tokens: TokenService
}

/**
 * `GET /api/accounts` and `POST /api/accounts/topup` (§12.1).
 */
export function accountRouter({
  prisma,
  accounts,
  transfers,
  tokens,
}: AccountRouterDependencies): Router {
  const router = Router()

  router.get("/api/accounts", requireAuth(tokens), async (req, res) => {
    const userId = req.userId
    if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    // Resolved through the token rather than an id in the request (FR-4.5).
    const overview = await accounts.overview(userId)
    if (!overview) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    /*
     * From `TransferService`, not recomputed here (P-32). The figure the wizard
     * shows and the rule that would refuse the transfer are the same function,
     * so a screen cannot promise an allowance the server then declines.
     *
     * WEB because this response is what the web reads. The USSD channel has its
     * own ceiling and no screen to put it on.
     */
    const usable = overview.accounts.find((account) => account.type === "USER")
    const daily = usable
      ? await transfers.dailyAllowance(usable.id, "WEB")
      : { limit: CHANNEL_LIMITS.WEB.daily, spent: 0n, remaining: CHANNEL_LIMITS.WEB.daily }

    respond(res, 200, accountsResponseSchema, {
      // §12.2, §9.3: balances leave as strings. A BigInt has no JSON form, and
      // one narrowed to a number loses precision above 2^53. Converting here
      // rather than in the service keeps the domain in bigint, where the
      // arithmetic has to happen.
      accounts: overview.accounts.map((account) => ({
        id: account.id,
        currency: account.currency,
        balance: account.balance.toString(),
        type: account.type,
      })),
      user: overview.user,
      limits: {
        perOperation: CHANNEL_LIMITS.WEB.perOperation.toString(),
        daily: {
          limit: daily.limit.toString(),
          spent: daily.spent.toString(),
          remaining: daily.remaining.toString(),
        },
      },
    })
  })

  /**
   * FR-10. Money-moving, so §12.2's `Idempotency-Key` rule applies: a
   * double-tapped "Demo top-up" button must not mint twice.
   */
  router.post(
    "/api/accounts/topup",
    requireAuth(tokens),
    requireCurrentSession(prisma),
    async (req, res) => {
      const userId = req.userId
      if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

      const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"))
      if (!key.success) {
        throw new ValidationError([{ path: ["Idempotency-Key"], code: "field.required" }])
      }

      // The amount is fixed by FR-10.1 and the account comes from the token, so
      // this endpoint takes nothing. It still refuses a body rather than
      // ignoring one: every other inbound schema here is strict on the grounds
      // that an unexpected field means the client and server disagree, and a
      // client that believes it controls the top-up amount was getting a 201.
      topUpRequestSchema.parse(req.body ?? {})

      const result = await transfers.topUp(userId, key.data)
      respond(res, 201, transferResponseSchema, toWire(result))
    },
  )

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
