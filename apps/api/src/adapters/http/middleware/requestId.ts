import { randomUUID } from "node:crypto"
import type { RequestHandler } from "express"

export const REQUEST_ID_HEADER = "x-request-id"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

declare module "express-serve-static-core" {
  interface Request {
    /** Correlates this request with its log lines and its error response (NFR-5.1). */
    requestId: string
  }
}

/**
 * Every request carries an id, and every response echoes it (NFR-5.1).
 *
 * An inbound `x-request-id` is honoured only when it is a well-formed UUID.
 * Reflecting arbitrary client input into log lines and response headers invites
 * log injection and lets a caller collide two unrelated requests onto one id,
 * which is worse than having no correlation at all.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get(REQUEST_ID_HEADER)
  req.requestId = inbound && UUID_RE.test(inbound) ? inbound : randomUUID()
  res.setHeader(REQUEST_ID_HEADER, req.requestId)
  next()
}
