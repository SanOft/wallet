import type { PrismaClient } from "@prisma/client"
import express, { type Express } from "express"
import { pinoHttp } from "pino-http"
import type { Logger } from "../../infra/logger.js"
import { createErrorHandler } from "./middleware/errorHandler.js"
import { requestId } from "./middleware/requestId.js"
import { healthRouter } from "./routes/health.js"

export interface AppDependencies {
  readonly prisma: PrismaClient
  readonly log: Logger
}

/**
 * Builds the HTTP adapter (spec §8.3). This layer parses and formats; it holds
 * no business rules, and the domain it will call knows nothing about it.
 *
 * Middleware order is load-bearing:
 *   1. requestId — everything after it, including the logger, needs the id
 *   2. pino-http — so a request that later throws is still logged
 *   3. body parsing
 *   4. routes
 *   5. the error handler, which must come last to catch what they throw
 */
export function createApp({ prisma, log }: AppDependencies): Express {
  const app = express()

  // Render and Vercel sit in front of this process; without it every client IP
  // in the logs is the proxy's, and future rate limiting would bucket the whole
  // internet together. Trusting exactly one hop, not `true`, which would let a
  // caller forge X-Forwarded-For.
  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  app.use(requestId)

  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as express.Request).requestId,
      // The id is already on every line via genReqId; repeating the whole
      // request object would defeat the redaction budget and bloat the stream.
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  )

  // A wallet payload is a phone number and an amount. A generous limit here is
  // free memory pressure for an attacker to exploit.
  app.use(express.json({ limit: "16kb" }))

  app.use(healthRouter(prisma))

  // Express 5 forwards rejected promises from handlers to this automatically,
  // so an async route no longer needs a try/catch to avoid hanging.
  app.use(createErrorHandler(log))

  return app
}
