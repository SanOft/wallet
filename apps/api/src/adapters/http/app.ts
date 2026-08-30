import type { PrismaClient } from "@prisma/client"
import express, { type Express } from "express"
import { pinoHttp } from "pino-http"
import type { Env } from "../../config/env.js"
import type { AccountService } from "../../domain/AccountService.js"
import type { AuthService } from "../../domain/AuthService.js"
import type { RatesService } from "../../domain/RatesService.js"
import type { TransferService } from "../../domain/TransferService.js"
import type { TokenService } from "../../infra/jwt.js"
import { type Logger, serializeError, serializeRequest } from "../../infra/logger.js"
import { UssdAdapter } from "../ussd/UssdAdapter.js"
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js"
import { requestId } from "./middleware/requestId.js"
import { accountRouter } from "./routes/accounts.js"
import { authRouter } from "./routes/auth.js"
import { healthRouter } from "./routes/health.js"
import { rateRouter } from "./routes/rates.js"
import { recipientRouter } from "./routes/recipients.js"
import { transferRouter } from "./routes/transfers.js"
import { ussdRouter } from "./routes/ussd.js"
import {
  corsPolicy,
  globalRateLimit,
  loginRateLimit,
  noStore,
  registerRateLimit,
  securityHeaders,
  terminatePreflight,
  USSD_GATEWAY_PATH,
  varyOrigin,
} from "./security.js"

export interface AppDependencies {
  readonly prisma: PrismaClient
  readonly log: Logger
  readonly env: Env
  readonly auth: AuthService
  readonly accounts: AccountService
  readonly tokens: TokenService
  readonly transfers: TransferService
  readonly rates: RatesService
  /** Test seam for time-window rules; production uses the real clock. */
  readonly now?: () => number
}

/**
 * Builds the HTTP adapter (spec §8.3). This layer parses and formats, and the
 * domain it calls knows nothing about it.
 *
 * The exception this comment used to describe is closed. `routes/recipients.ts`
 * held FR-4.9's rate limit and queried Prisma directly, and it predicted its
 * own cost: "the USSD adapter (B6) needs recipient lookup and will either
 * reimplement the cap or share none of it". B6 reimplemented it. Both now go
 * through `AccountService`, which owns the budget, the query and the masking
 * as one thing (P-19, P-34).
 *
 * Middleware order is load-bearing:
 *   1. requestId — everything after it, including the logger, needs the id
 *   2. pino-http — so a request that later throws is still logged
 *   3. body parsing
 *   4. routes
 *   5. the not-found handler, which turns an unmatched path into a domain
 *      error instead of Express's HTML page
 *   6. the error handler, which must come last to catch what they throw
 */
export function createApp({
  prisma,
  log,
  env,
  auth,
  accounts,
  tokens,
  transfers,
  rates,
  now: nowFn,
}: AppDependencies): Express {
  const app = express()

  // Render sits in front of this process; without it every client IP in the
  // logs is the proxy's, and future rate limiting would bucket the whole
  // internet together. Trusting exactly one hop, not `true`, which would let a
  // caller forge X-Forwarded-For.
  //
  // Caveat worth knowing before anything keys on it: off-Render — locally, or
  // on any deployment reachable without passing through the load balancer —
  // `req.ip` and `req.secure` are client-controlled, because the single hop
  // this trusts is then the client itself.
  app.set("trust proxy", env.TRUST_PROXY_HOPS)
  app.disable("x-powered-by")

  // Before anything that reads the request: the headers belong on every
  // response including the error ones.
  app.use(securityHeaders())
  app.use(noStore())
  app.use(varyOrigin())

  // Ahead of CORS, deliberately. `cors` answers an allowed preflight itself and
  // returns, so anything mounted after it never sees one — which left every
  // preflight uncounted by both limiters and unlabelled by `requestId`. Five
  // hundred of them cost nothing and appeared nowhere. Identity and metering
  // now come first, and CORS decides only what a browser may do with the
  // response.
  app.use(requestId)

  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as express.Request).requestId,
      /**
       * pino-http installs its own req/res serializers and they take precedence
       * over the logger's, so they have to be repeated here. Its default writes
       * `originalUrl` with the query string and the full header block — which is
       * how a phone number and an Authorization header reach the log stream
       * without any developer call site being involved (NFR-5.2).
       */
      serializers: {
        req: serializeRequest,
        err: serializeError,
      },
      // A successful health check every few seconds would bury the stream, but
      // a failing one is the single most important operational event there is —
      // so the filter is on the outcome, not on the path.
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error"
        if (res.statusCode >= 400) return "warn"
        return req.url === "/health" ? "silent" : "info"
      },
    }),
  )

  // A wallet payload is a phone number and an amount. A generous limit here is
  // free memory pressure for an attacker to exploit. Parse failures and
  // oversized bodies are mapped to 4xx codes by the error handler.
  // After the body limit would be too late for a flood of small requests, and
  // before the routers so a throttled caller costs nothing but the counter.
  /*
   * Everywhere except the gateway callback, which is metered per subscriber
   * instead (P-33). Leaving it here as well would put the address budget back
   * in front: a gateway is one address for a whole network, and the first
   * limiter to refuse is the one that decides what the subscriber sees.
   */
  /*
   * Built once, outside the handler.
   *
   * Calling `globalRateLimit()` per request looked like the same thing and was
   * not: `rateLimit()` constructs its own `MemoryStore` when none is passed, so
   * every request got a counter starting at zero and the limit never fired.
   * Nothing went red — the middleware was mounted, the code path ran, and the
   * control was simply dead. Introduced with this exemption and caught by
   * review rather than by a test, which is why there is now a test.
   */
  const globalLimit = globalRateLimit()

  app.use((req, res, next) => {
    if (req.path === USSD_GATEWAY_PATH) {
      next()
      return
    }
    globalLimit(req, res, next)
  })
  /*
   * Separate budgets, because the two endpoints are limiting different things:
   * registration caps identities created (successes included, P-20), login
   * caps passwords guessed (failures only, P-25).
   */
  app.use("/api/auth/register", registerRateLimit())
  app.use("/api/auth/login", loginRateLimit())

  // Only now: a refused origin has already been counted, and an allowed
  // preflight is answered here.
  app.use(corsPolicy(env))
  // Whatever `cors` left unanswered — a refused origin, or no origin at all —
  // ends here rather than in Express's automatic OPTIONS handler, which
  // discloses the route's verb list to precisely the caller CORS refused.
  app.use(terminatePreflight())

  app.use(express.json({ limit: "16kb" }))

  app.use(healthRouter(prisma, env.TRUST_PROXY_HOPS))
  app.use(authRouter({ auth, tokens, env, prisma }))
  app.use(transferRouter({ transfers, tokens, prisma }))
  app.use(accountRouter({ prisma, accounts, transfers, tokens }))
  app.use(recipientRouter({ accounts, tokens }))
  app.use(rateRouter({ rates, tokens }))

  /*
   * FR-9. Built here rather than injected, because it holds FR-4.9's lookup
   * window in memory and one app must own exactly one of those — the same
   * reason `routes/recipients.ts` keeps its counter module-scoped.
   *
   * `warn` is where this channel's honesty lives: the adapter never throws, so
   * a refusal or a bug would otherwise leave a phone screen with a sentence on
   * it and the log with nothing at all.
   */
  const ussd = new UssdAdapter({
    prisma,
    auth,
    accounts,
    transfers,
    warn: (event, cause) => log.error({ event, err: cause }, "ussd"),
    ...(nowFn ? { now: () => new Date(nowFn()) } : {}),
  })

  app.use(ussdRouter({ ussd, tokens, prisma, gatewaySecret: env.USSD_GATEWAY_SECRET }))

  app.use(notFoundHandler)

  // Express 5 forwards rejected promises from handlers to this automatically,
  // so an async route no longer needs a try/catch to avoid hanging.
  app.use(createErrorHandler(log))

  return app
}
