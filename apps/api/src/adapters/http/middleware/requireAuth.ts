import type { RequestHandler } from "express"
import { DomainError } from "../../../domain/errors.js"
import type { TokenService } from "../../../infra/jwt.js"

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `requireAuth`. Absent on unauthenticated routes. */
    userId?: string
  }
}

/**
 * Bearer-token gate for the routes §12.1 marks with a tick.
 *
 * Every failure — absent header, wrong scheme, expired token, forged
 * signature, wrong audience — produces the same `AUTH_TOKEN_EXPIRED`. The
 * client's only correct reaction is to refresh and retry (11.3), and telling it
 * *why* the token failed would let a caller probe our verification rules.
 */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    const header = req.get("authorization")
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined

    if (!token) {
      next(new DomainError("AUTH_TOKEN_EXPIRED", "Missing access token"))
      return
    }

    tokens
      .verify(token)
      .then((claims) => {
        if (!claims) {
          next(new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid"))
          return
        }
        req.userId = claims.userId
        next()
      })
      .catch(next)
  }
}
