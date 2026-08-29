import { randomUUID } from "node:crypto"
import type { RequestHandler } from "express"

export const REQUEST_ID_HEADER = "x-request-id"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

declare module "express-serve-static-core" {
  interface Request {
    /**
     * What the *caller* calls this request. Echoed in the response header and
     * the §12.3 envelope so a client can correlate its own call.
     *
     * Accepted from `x-request-id` when well formed, which means it is not
     * evidence of anything: two requests can carry the same value, and a
     * caller can reuse one it has seen.
     */
    requestId: string
    /**
     * What the *server* calls this request, and the only one of the two that
     * can be relied on (P-24).
     *
     * Minted here, never read from the request, never accepted from a header.
     * §17.1 answers Repudiation — "I never sent this money" — with these logs,
     * and a correlation key the accused chooses is not corroboration. Every
     * log line carries it.
     */
    traceId: string
  }
}

/**
 * Two ids, because they answer different questions (NFR-5.1, P-24).
 *
 * `requestId` is the caller's. An inbound `x-request-id` is honoured when it is
 * a well-formed UUID, and echoed, because a client correlating its own call is
 * the reason the header exists. The format check stops log injection, which was
 * its stated purpose — and that is all it stops.
 *
 * `traceId` is the server's, and it is the one the logs are keyed on. The
 * format check never made the caller's id *trustworthy*: a caller can put the
 * same value on a thousand requests, or reuse one it saw in an error message,
 * and every line about those requests then reads as one. §17.1 answers
 * Repudiation with these logs, so the correlation key cannot be a field the
 * accused controls.
 *
 * Not exposed on the response. It is for whoever reads the logs, and a client
 * has `requestId` for its own purposes; adding a second header would put a
 * value on the wire that nothing consumes.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get(REQUEST_ID_HEADER)
  req.requestId = inbound && UUID_RE.test(inbound) ? inbound : randomUUID()
  req.traceId = randomUUID()
  res.setHeader(REQUEST_ID_HEADER, req.requestId)
  next()
}
