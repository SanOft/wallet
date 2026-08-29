import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino"
import type { Env } from "../config/env.js"

/**
 * NFR-5.2: passwords, tokens, PINs and full phone numbers are never logged.
 *
 * Enforcement is by *serializer* first and by redaction list second, in that
 * order and for a reason. A path list can only redact keys someone thought to
 * enumerate, and fast-redact wildcards match exactly one level — so
 * `{ recipient: { phone } }`, `[{ phone }]`, an interpolated message, and above
 * all pino-http's default `req.url` (which carries the query string verbatim)
 * all walk straight past it. The serializers below decide what may be logged at
 * all; the path list then catches stragglers inside whatever survives.
 */

/** Everything else in a query string is redacted, including unknown keys. */
const SAFE_QUERY_KEYS = new Set(["cursor", "from", "to", "type", "status", "limit"])

const REDACTED = "[redacted]"

/**
 * A phone keeps its calling-code prefix and last two digits. A log line that
 * cannot say which subscriber is useless for support; one that says it fully
 * violates NFR-5.2. Anything too short to mask that way is redacted outright
 * rather than emitted whole — a 6-character value would otherwise survive
 * untouched, which is how a masking helper quietly becomes a passthrough.
 */
export function maskPhone(value: string): string {
  if (value.length < 9) return REDACTED
  return `${value.slice(0, 4)}${"*".repeat(value.length - 6)}${value.slice(-2)}`
}

function censor(value: unknown, path: readonly string[]): string {
  const key = path[path.length - 1] ?? ""
  if ((key === "phone" || key === "phoneNumber") && typeof value === "string") {
    return maskPhone(value)
  }
  return REDACTED
}

/**
 * Defence in depth only. Every entry here is a straggler-catcher; none is the
 * primary control. Adding a key here is not the same as covering a shape.
 */
const REDACTED_PATHS = [
  "password",
  "passwordHash",
  "pin",
  "pinHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "phone",
  "phoneNumber",
  "*.password",
  "*.passwordHash",
  "*.pin",
  "*.pinHash",
  "*.token",
  "*.tokenHash",
  "*.accessToken",
  "*.refreshToken",
  "*.phone",
  "*.phoneNumber",
]

interface IncomingLike {
  readonly id?: unknown
  readonly method?: string
  readonly url?: string
  readonly originalUrl?: string
  /**
   * The Express request, which is not what this serializer is handed.
   *
   * pino-http passes a wrapper carrying `id`, `method`, `url` and `headers` —
   * so `req.traceId`, set by our own middleware on the Express request, is
   * simply absent here. That is easy to miss because the wrapper has enough of
   * the same fields to look like the real thing: `url` resolves, and only the
   * property nobody else sets comes back undefined.
   */
  readonly raw?: { readonly traceId?: unknown }
}

/**
 * Replaces pino-http's default request serializer, which logs `originalUrl`
 * including the query string. `GET /recipients/lookup?phone=%2B998901234567`
 * would otherwise write a complete MSISDN on every request, with no developer
 * call site involved and nothing in the redaction list able to see it.
 *
 * The field is named `requestId` rather than pino-http's `id` so that one query
 * finds every line about a request — the response header, the error envelope
 * and the access log now agree on the name (E7, NFR-5.1).
 *
 * `traceId` sits beside it and is the one to trust. See `requestId.ts`.
 */
export function serializeRequest(req: IncomingLike): Record<string, unknown> {
  const raw = req.originalUrl ?? req.url ?? ""
  const questionMark = raw.indexOf("?")
  const path = questionMark === -1 ? raw : raw.slice(0, questionMark)
  const search = questionMark === -1 ? "" : raw.slice(questionMark + 1)

  const query: Record<string, string> = {}
  if (search) {
    for (const [key, value] of new URLSearchParams(search)) {
      query[key] = SAFE_QUERY_KEYS.has(key) ? value : REDACTED
    }
  }

  return {
    /*
     * Both, and the order is the point. `traceId` is minted by the server and
     * cannot be set by the caller (P-24); `requestId` is whatever the caller
     * asked to be called, which is useful for answering them and is not
     * evidence. A query that has to be right uses `traceId`.
     */
    traceId: req.raw?.traceId,
    requestId: req.id,
    method: req.method,
    // Path only. The query is reported separately, allowlisted by key.
    path,
    ...(search ? { query } : {}),
  }
}

interface ErrorLike {
  readonly name?: string
  readonly message?: string
  readonly stack?: string
  readonly code?: unknown
}

/**
 * Replaces pino's default error serializer, which copies every enumerable own
 * property. A driver error routinely carries the connection string on a
 * property such as `err.config`, and `err.cause` is folded into the message —
 * neither is reachable by a redaction path. This allowlists the fields worth
 * having and discards the rest, so a dependency upgrade cannot widen what we
 * write without someone editing this function.
 */
export function serializeError(err: ErrorLike): Record<string, unknown> {
  return {
    type: err.name ?? "Error",
    message: typeof err.message === "string" ? err.message : undefined,
    stack: err.stack,
    ...(typeof err.code === "string" || typeof err.code === "number" ? { code: err.code } : {}),
  }
}

export function createLogger(env: Env, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor },
    serializers: {
      req: serializeRequest,
      err: serializeError,
      // An object logged under `error` gets no serializer by default, so the
      // same allowlist is bound to both names.
      error: serializeError,
    },
    // Emit `"level":"info"` rather than `"level":30`; a human reads these in the
    // Render log stream, not only a parser.
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "wallet-api" },
  } satisfies LoggerOptions

  return destination ? pino(options, destination) : pino(options)
}

export type { Logger }
