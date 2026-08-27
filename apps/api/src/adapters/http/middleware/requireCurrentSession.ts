import type { PrismaClient } from "@prisma/client"
import type { RequestHandler } from "express"
import { DomainError } from "../../../domain/errors.js"

/**
 * Refuses an access token minted before the user's sessions were revoked
 * (FR-2.6, P-16).
 *
 * A JWT carries its own authority: nothing consults the database to use one, so
 * revoking a refresh family stops the *refresh* immediately and leaves the
 * stolen access token working until it expires. FR-2.6 states that bound —
 * fifteen minutes — rather than hiding it, and this closes it for the routes
 * where fifteen minutes is too long.
 *
 * Mounted only on the endpoints that move money, which is the whole design.
 * Putting it on every route would add a database read to `/me`, to history, to
 * the balance — the reads a client makes constantly — to shorten a window that
 * only matters where something irreversible happens. §12.1's tick marks which
 * routes need a session; this marks the smaller set that needs a *current* one.
 *
 * Runs after `requireAuth`, and says so by failing loudly rather than passing
 * an unauthenticated request through.
 */
export function requireCurrentSession(prisma: PrismaClient): RequestHandler {
  return (req, _res, next) => {
    const userId = req.userId
    const issuedAt = req.tokenIssuedAt

    if (!userId || issuedAt === undefined) {
      next(new Error("requireCurrentSession must be mounted after requireAuth"))
      return
    }

    prisma.user
      .findUnique({ where: { id: userId }, select: { tokensValidAfter: true } })
      .then((user) => {
        const cutoff = user?.tokensValidAfter
        if (!cutoff) {
          next()
          return
        }

        /*
         * `iat` is whole seconds and the cutoff has millisecond precision, so a
         * token minted in the same second as the revocation compares as equal
         * or newer and would survive. Rounding the cutoff up closes that
         * second — the direction that refuses a doubtful token rather than
         * accepting it.
         */
        const cutoffSeconds = Math.ceil(cutoff.getTime() / 1000)
        if (issuedAt < cutoffSeconds) {
          // The same code every other token failure produces (§12.1): the
          // client's correct reaction is to refresh, and its refresh token was
          // revoked in the same moment, so it will be sent to sign in again.
          next(new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid"))
          return
        }

        next()
      })
      .catch(next)
  }
}
