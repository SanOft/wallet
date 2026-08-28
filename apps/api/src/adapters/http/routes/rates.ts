import { ratesResponseSchema } from "@wallet/shared"
import { Router } from "express"
import type { RatesService } from "../../../domain/RatesService.js"
import type { TokenService } from "../../../infra/jwt.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { respond } from "../respond.js"

export interface RateRouterDependencies {
  readonly rates: RatesService
  readonly tokens: TokenService
}

/**
 * `GET /api/rates` (FR-7, §12.1).
 *
 * Behind `requireAuth` as §12.1 specifies, although nothing here is personal —
 * the numbers are published by a central bank. Keeping it authenticated means
 * the rate limiter counts it against a known caller rather than leaving an
 * unauthenticated proxy to the central bank open on our origin.
 */
export function rateRouter({ rates, tokens }: RateRouterDependencies): Router {
  const router = Router()

  router.get("/api/rates", requireAuth(tokens), async (_req, res) => {
    const snapshot = await rates.current()

    respond(res, 200, ratesResponseSchema, {
      rates: snapshot.rates,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      stale: snapshot.stale,
    })
  })

  return router
}
