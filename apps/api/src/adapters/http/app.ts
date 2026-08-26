import type { PrismaClient } from "@prisma/client"
import express, { type Express } from "express"
import { pinoHttp } from "pino-http"
import type { Env } from "../../config/env.js"
import type { AuthService } from "../../domain/AuthService.js"
import type { TransferService } from "../../domain/TransferService.js"
import type { TokenService } from "../../infra/jwt.js"
import { type Logger, serializeError, serializeRequest } from "../../infra/logger.js"
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js"
import { requestId } from "./middleware/requestId.js"
import { accountRouter } from "./routes/accounts.js"
import { authRouter } from "./routes/auth.js"
import { healthRouter } from "./routes/health.js"
import { recipientRouter } from "./routes/recipients.js"
import { transferRouter } from "./routes/transfers.js"

export interface AppDependencies {
  readonly prisma: PrismaClient
  readonly log: Logger
  readonly env: Env
  readonly auth: AuthService
  readonly tokens: TokenService
  readonly transfers: TransferService
}

/**
 * Builds the HTTP adapter (spec §8.3). This layer parses and formats; it holds
 * no business rules, and the domain it calls knows nothing about it.
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
export function createApp({ prisma, log, env, auth, tokens, transfers }: AppDependencies): Express {
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
  app.set("trust proxy", 1)
  app.disable("x-powered-by")

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
  app.use(express.json({ limit: "16kb" }))

  app.use(healthRouter(prisma))
  app.use(authRouter({ auth, tokens, env }))
  app.use(transferRouter({ transfers, tokens }))
  app.use(accountRouter({ prisma, transfers, tokens }))
  app.use(recipientRouter({ prisma, tokens }))

  app.use(notFoundHandler)

  // Express 5 forwards rejected promises from handlers to this automatically,
  // so an async route no longer needs a try/catch to avoid hanging.
  app.use(createErrorHandler(log))

  return app
}
