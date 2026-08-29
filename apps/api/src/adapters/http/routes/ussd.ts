import { timingSafeEqual } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { ussdCallbackSchema } from "@wallet/shared"
import express, { type Response, Router } from "express"
import { DomainError, ValidationError } from "../../../domain/errors.js"
import type { TokenService } from "../../../infra/jwt.js"
import type { UssdAdapter, UssdReply } from "../../ussd/UssdAdapter.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireCurrentSession } from "../middleware/requireCurrentSession.js"

/**
 * FR-9.1's callback, and FR-9.6's simulator, on one handler.
 *
 * Two doors into the same room, because they differ in exactly one thing —
 * how the caller's number is established — and in nothing else. The gateway
 * asserts it with a shared secret; the simulator proves it with the session
 * the person is already logged into. Everything downstream, including which
 * step of §11.7 this is and what it costs, is the same code.
 *
 * That split is what makes FR-9.6's "fully protocol-compliant" claim
 * survivable. The alternative was to ship the gateway secret to the browser so
 * the simulator could use the real door, which would have put a server
 * credential in a public bundle and let anybody dial as anybody.
 */

export interface UssdRouterDependencies {
  readonly ussd: UssdAdapter
  readonly tokens: TokenService
  readonly prisma: PrismaClient
  /**
   * Absent by default, and that closes the gateway route rather than opening
   * it. There is no real shortcode in the MVP (FR-9.6), so an unset secret is
   * the expected production state — and "unconfigured" must never be the same
   * as "unauthenticated callers welcome".
   */
  readonly gatewaySecret?: string | undefined
}

/** FR-9.3. The space is part of the protocol, not formatting. */
function sendReply(res: Response, reply: UssdReply): void {
  // Always 200, including for a refusal: a gateway reads a non-2xx as a failed
  // session and shows the subscriber its own error instead of ours.
  res.status(200).type("text/plain; charset=utf-8").send(`${reply.kind} ${reply.text}`)
}

/**
 * Which side sent something wrong.
 *
 * `text` and `phoneNumber` are the subscriber's; the rest is the gateway's
 * envelope. A bad envelope is an integration fault and deserves the §12.3 JSON
 * a developer will read. A bad subscriber field must not be — that JSON would
 * land on a feature phone.
 */
const SUBSCRIBER_FIELDS = new Set(["text", "phoneNumber"])

export function ussdRouter({
  ussd,
  tokens,
  prisma,
  gatewaySecret,
}: UssdRouterDependencies): Router {
  const router = Router()

  router.post(
    "/api/channels/ussd",
    /*
     * Gateways post form-encoded bodies; `express.json` upstream does not
     * touch those, so without this the route sees an empty object and answers
     * every real callback with a validation error. Mounted here rather than
     * app-wide so no other endpoint gains a second body format it never
     * checked for.
     */
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      if (!authenticGateway(req.get("x-gateway-secret"), gatewaySecret)) {
        // A JSON 401. The caller here is an integration, not a person holding
        // a phone, and it is the one caller that can read this envelope.
        throw new DomainError("AUTH_INVALID_CREDENTIALS", "Gateway secret is not valid")
      }

      const callback = ussdCallbackSchema.safeParse(req.body)
      if (!callback.success) {
        const subscriberFault = callback.error.issues.some((issue) =>
          SUBSCRIBER_FIELDS.has(String(issue.path[0])),
        )
        if (!subscriberFault) {
          throw new ValidationError(
            callback.error.issues.map((issue) => ({
              path: issue.path.map((segment) => String(segment)),
              code: "field.required" as const,
            })),
          )
        }
        sendReply(res, { kind: "END", text: "So'rov noto'g'ri." })
        return
      }

      sendReply(res, await ussd.handle(callback.data))
    },
  )

  /**
   * FR-9.6's simulator, behind the caller's own session.
   *
   * `requireCurrentSession` because this door moves money exactly as
   * `/api/transfers` does, and P-16 scoped that check to precisely those
   * routes.
   */
  router.post(
    "/api/channels/ussd/simulate",
    requireAuth(tokens),
    requireCurrentSession(prisma),
    async (req, res) => {
      const userId = req.userId
      if (!userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } })
      if (!user) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

      const callback = ussdCallbackSchema.safeParse({
        ...req.body,
        /*
         * Overwritten, not validated against the body.
         *
         * The number is the whole identity on this channel, so a simulator
         * that let the caller name it would be an endpoint for dialling as
         * somebody else — and it would be the only place in this codebase
         * where who you are comes from a request body rather than a token
         * (FR-4.5).
         */
        phoneNumber: user.phone,
      })

      if (!callback.success) {
        sendReply(res, { kind: "END", text: "So'rov noto'g'ri." })
        return
      }

      sendReply(res, await ussd.handle(callback.data))
    },
  )

  return router
}

/**
 * Constant-time, and closed when unset.
 *
 * `===` on a secret leaks its prefix through timing; the lengths are compared
 * first because `timingSafeEqual` throws on a mismatch, and that throw is
 * itself a length oracle if it escapes.
 */
function authenticGateway(presented: string | undefined, expected: string | undefined): boolean {
  if (!expected || !presented) return false

  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
