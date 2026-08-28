import type { PrismaClient } from "@prisma/client"
import {
  authResponseSchema,
  loginRequestSchema,
  publicUserSchema,
  registerRequestSchema,
  setPinRequestSchema,
} from "@wallet/shared"
import { Router } from "express"
import type { Env } from "../../../config/env.js"
import type { AuthService } from "../../../domain/AuthService.js"
import { DomainError, RefreshTokenInvalidError } from "../../../domain/errors.js"
import type { TokenService } from "../../../infra/jwt.js"
import { clearRefreshCookie, REFRESH_COOKIE, readCookie, setRefreshCookie } from "../cookies.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireCurrentSession } from "../middleware/requireCurrentSession.js"
import { respond } from "../respond.js"

export interface AuthRouterDependencies {
  /** Only for `requireCurrentSession`, which reads `tokensValidAfter` (P-16). */
  readonly prisma: PrismaClient
  readonly auth: AuthService
  readonly tokens: TokenService
  readonly env: Env
}

/**
 * The HTTP adapter for authentication (§12.1).
 *
 * Everything here is parsing and formatting: read the body through a shared
 * schema, hand plain values to the service, put what comes back on the wire.
 * The decision that a refresh token belongs in a cookie lives here rather than
 * in the domain, which is what lets the USSD channel reuse the same service
 * without ever knowing what a cookie is (§8.3).
 *
 * Express 5 forwards a rejected promise to the error middleware on its own, so
 * these handlers deliberately have no try/catch: a domain error thrown inside
 * one becomes its documented §12.3 envelope without this file naming a single
 * status code.
 */
export function authRouter({ auth, tokens, env, prisma }: AuthRouterDependencies): Router {
  const router = Router()

  router.post("/api/auth/register", async (req, res) => {
    // Validated server-side against the same schema the client used (NFR-1.6);
    // a ZodError here becomes VALIDATION_ERROR with per-field codes.
    const input = registerRequestSchema.parse(req.body)
    const session = await auth.register(input)

    setRefreshCookie(res, env, session.refreshToken)
    respond(res, 201, authResponseSchema, session.auth)
  })

  router.post("/api/auth/login", async (req, res) => {
    const input = loginRequestSchema.parse(req.body)
    const session = await auth.login(input)

    setRefreshCookie(res, env, session.refreshToken)
    respond(res, 200, authResponseSchema, session.auth)
  })

  /**
   * FR-2.6, FR-2.7. Unauthenticated by design: the whole point is that the
   * access token has expired, so the cookie is the only credential (11.3).
   */
  router.post("/api/auth/refresh", async (req, res) => {
    const token = readCookie(req.get("cookie"), REFRESH_COOKIE)
    if (!token) throw new RefreshTokenInvalidError()

    const session = await auth.refresh(token)

    setRefreshCookie(res, env, session.refreshToken)
    respond(res, 200, authResponseSchema, session.auth)
  })

  router.post("/api/auth/logout", async (req, res) => {
    const token = readCookie(req.get("cookie"), REFRESH_COOKIE)
    if (token) await auth.logout(token)

    // Cleared whether or not the token was known, so a caller holding a stale
    // cookie still ends up without one.
    clearRefreshCookie(res, env)
    res.status(204).end()
  })

  /**
   * `PUT /api/me/pin` (FR-1.6, §12.1).
   *
   * Behind `requireCurrentSession`: a PIN grants access to a channel that
   * moves money, so setting one is exactly the kind of change P-16 scoped that
   * check to. A token minted before a revocation must not be able to open a
   * second door with it.
   */
  router.put(
    "/api/me/pin",
    requireAuth(tokens),
    requireCurrentSession(prisma),
    async (req, res) => {
      if (!req.userId) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

      const input = setPinRequestSchema.parse(req.body)
      await auth.setPin(req.userId, input.currentPassword, input.pin)

      // 204: there is nothing to return, and returning the user would tempt a
      // client into treating this as a place to read state from.
      res.status(204).end()
    },
  )

  router.get("/api/me", requireAuth(tokens), async (req, res) => {
    const user = req.userId ? await auth.currentUser(req.userId) : null

    // A valid token for a user who no longer exists is not a 404 — it is a
    // credential that should stop working.
    if (!user) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    respond(res, 200, publicUserSchema, user)
  })

  return router
}
