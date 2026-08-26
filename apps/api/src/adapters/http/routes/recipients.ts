import type { PrismaClient } from "@prisma/client"
import {
  createRegionalPhoneSchema,
  DEFAULT_REGION,
  maskRecipientName,
  recipientLookupSchema,
} from "@wallet/shared"
import { Router } from "express"
import { DomainError, RecipientNotFoundError, ValidationError } from "../../../domain/errors.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { respond } from "../respond.js"

/** FR-4.9: twenty lookups per user per hour. */
const LOOKUP_LIMIT = 20
const LOOKUP_WINDOW_MS = 60 * 60 * 1000

/**
 * Sliding window per user, in memory.
 *
 * Stated plainly, because this is the weakest control in the branch: the
 * counter resets when the process restarts, and it is not shared between
 * instances. Render's free tier runs one instance (§20.3) and sleeps after
 * inactivity, so a determined enumerator could wait out a cold start.
 *
 * The alternative — an eighth table — deviates from §9.1's frozen data model
 * for a control that protects against *enumeration*, not against money moving.
 * A move to the database or to Redis belongs with the wider rate limiting at
 * B5, and is tracked in docs/PARKING.md.
 */
const lookupWindows = new Map<string, number[]>()

function withinLookupLimit(userId: string, now: number): boolean {
  const recent = (lookupWindows.get(userId) ?? []).filter((at) => at > now - LOOKUP_WINDOW_MS)

  if (recent.length >= LOOKUP_LIMIT) {
    lookupWindows.set(userId, recent)
    return false
  }

  recent.push(now)
  lookupWindows.set(userId, recent)
  return true
}

/** Exposed so tests can start from a known state rather than a shared one. */
export function resetLookupWindows(): void {
  lookupWindows.clear()
}

export interface RecipientRouterDependencies {
  readonly prisma: PrismaClient
  readonly tokens: TokenService
}

/**
 * `GET /api/recipients/lookup?phone=` (§12.1, FR-4.9).
 *
 * The whole endpoint is an enumeration surface: it answers "is this number
 * registered, and who is it". Three things keep that narrow — an exact
 * full-number match only, a masked name, and a per-user hourly cap.
 */
export function recipientRouter({ prisma, tokens }: RecipientRouterDependencies): Router {
  const router = Router()
  const phoneSchema = createRegionalPhoneSchema(DEFAULT_REGION)

  router.get("/api/recipients/lookup", requireAuth(tokens), async (req, res) => {
    const userId = req.userId
    if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    const phone = phoneSchema.safeParse(req.query.phone)
    if (!phone.success) {
      throw new ValidationError([{ path: ["phone"], code: "phone.invalid_format" }])
    }

    if (!withinLookupLimit(userId, Date.now())) {
      throw new DomainError("RATE_LIMITED", "Too many lookups")
    }

    const recipient = await prisma.user.findFirst({
      // An exact match on the full number. There is no prefix search and no
      // partial match, so the endpoint cannot be walked.
      where: { phone: phone.data, accounts: { some: { type: "USER" } } },
      select: { phone: true, firstName: true, lastName: true },
    })

    // The same answer whether the number is unregistered or belongs to the
    // treasury: a caller learns only that they cannot pay it.
    if (!recipient) throw new RecipientNotFoundError()

    respond(res, 200, recipientLookupSchema, {
      phone: recipient.phone,
      // Masked before it leaves the process, so a full surname is never on the
      // wire even if a future route forgets (FR-4.6).
      maskedName: maskRecipientName(recipient.firstName, recipient.lastName),
    })
  })

  return router
}
