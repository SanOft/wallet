import { createRegionalPhoneSchema, DEFAULT_REGION, recipientLookupSchema } from "@wallet/shared"
import { Router } from "express"
import type { AccountService } from "../../../domain/AccountService.js"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { respond } from "../respond.js"

export interface RecipientRouterDependencies {
  readonly accounts: AccountService
  readonly tokens: TokenService
}

/**
 * `GET /api/recipients/lookup?phone=` (§12.1, FR-4.9).
 *
 * The whole endpoint is an enumeration surface: it answers "is this number
 * registered, and who is it". Three things keep that narrow — an exact
 * full-number match only, a masked name, and a per-user hourly cap — and all
 * three now live in `AccountService`, because the USSD channel asks the same
 * question and used to answer it with its own copy of the rules (P-19, P-34).
 *
 * What is left here is what an adapter is for: parse the query, format the
 * response.
 */
export function recipientRouter({ accounts, tokens }: RecipientRouterDependencies): Router {
  const router = Router()
  const phoneSchema = createRegionalPhoneSchema(DEFAULT_REGION)

  router.get("/api/recipients/lookup", requireAuth(tokens), async (req, res) => {
    const userId = req.userId
    if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    const phone = phoneSchema.safeParse(req.query.phone)
    if (!phone.success) {
      throw new ValidationError([{ path: ["phone"], code: "phone.invalid_format" }])
    }

    const recipient = await accounts.lookupRecipient(userId, phone.data)
    respond(res, 200, recipientLookupSchema, recipient)
  })

  return router
}
