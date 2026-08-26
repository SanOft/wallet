import {
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  apiErrorSchema,
  type FieldIssue,
  fieldErrorCodeSchema,
} from "@wallet/shared"
import type { ErrorRequestHandler, RequestHandler } from "express"
import * as z from "zod"
import { isDomainError } from "../../../domain/errors.js"
import type { Logger } from "../../../infra/logger.js"

/**
 * The single place a failure becomes an HTTP response (spec §12.3).
 *
 * `code` is the contract; `message` is a fallback for logs and debugging, and
 * the client renders its own text from the code. The status is read from
 * API_ERROR_STATUS in @wallet/shared rather than written here, so the two
 * cannot drift apart.
 *
 * The catalog covers errors the framework raises as well as ours. Malformed
 * JSON and oversized bodies used to fall through to INTERNAL, which §12.3
 * marks retryable — so the offline outbox (FR-8.4) would have retried a
 * permanently broken payload with backoff, forever.
 */

/** Debugging fallbacks. The user-facing text is the client's job (§12.3). */
const FALLBACK_MESSAGE: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: "Request validation failed",
  REGISTRATION_FAILED: "Registration failed",
  AUTH_INVALID_CREDENTIALS: "Invalid credentials",
  AUTH_TOKEN_EXPIRED: "Access token expired",
  AUTH_REFRESH_REUSED: "Refresh token reuse detected",
  AUTH_REFRESH_INVALID: "Refresh credential is not valid",
  AUTH_LOCKED: "Account temporarily locked",
  RATE_LIMITED: "Too many requests",
  NOT_FOUND: "No such endpoint",
  MALFORMED_BODY: "Request body could not be parsed",
  PAYLOAD_TOO_LARGE: "Request body is too large",
  RECIPIENT_NOT_FOUND: "Recipient not found",
  SELF_TRANSFER_FORBIDDEN: "Cannot transfer to your own account",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  LIMIT_EXCEEDED: "Transfer limit exceeded",
  IDEMPOTENCY_CONFLICT: "Idempotency key reused with a different payload",
  PIN_NOT_SET: "PIN is not set",
  PIN_LOCKED: "PIN is locked",
  INTERNAL: "Internal error",
}

/** §12.3: `details` names which field failed, or which limit was hit. */
const CODES_CARRYING_DETAILS: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "VALIDATION_ERROR",
  "LIMIT_EXCEEDED",
])

/**
 * body-parser signals its failures with a `type` string. Mapping them here is
 * what keeps a client typo out of the retryable 5xx band, and out of the error
 * log where it would page someone.
 */
const BODY_PARSER_CODE: Record<string, ApiErrorCode> = {
  "entity.parse.failed": "MALFORMED_BODY",
  "entity.too.large": "PAYLOAD_TOO_LARGE",
  "entity.verification.failed": "MALFORMED_BODY",
  "encoding.unsupported": "MALFORMED_BODY",
  "charset.unsupported": "MALFORMED_BODY",
  "request.aborted": "MALFORMED_BODY",
}

function bodyParserCode(err: unknown): ApiErrorCode | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const type = (err as { type?: unknown }).type
  return typeof type === "string" ? BODY_PARSER_CODE[type] : undefined
}

/**
 * Our shared schemas carry their field code as the Zod issue message
 * (`{ error: "phone.invalid_format" }`), so a well-formed issue maps directly.
 *
 * An issue whose message is not in the closed field-code enum is a defect in
 * the schema that produced it, not something to paper over: inventing a
 * plausible code would ship a lie to a client that trusts the enum to be
 * closed. Such issues are dropped and reported at `warn` so the schema is
 * fixed — but see `field.required` below for why the response is never empty.
 */
function toFieldIssues(error: z.ZodError, log: Logger, requestId: string): FieldIssue[] {
  const mapped: FieldIssue[] = []

  for (const issue of error.issues) {
    const code = fieldErrorCodeSchema.safeParse(issue.message)
    if (code.success) {
      mapped.push({ path: issue.path.map(String), code: code.data })
    } else {
      log.warn(
        { requestId, path: issue.path.map(String), zodCode: issue.code },
        "Zod issue carries no field error code; the schema is missing an `error` value",
      )
      // The client is told VALIDATION_ERROR means "shown under the field". An
      // empty details array would leave it with a failure and nothing to show,
      // so the field is still named even when its reason could not be mapped.
      mapped.push({ path: issue.path.map(String), code: "field.required" })
    }
  }

  return mapped
}

/**
 * Terminal handler for a request that matched no route. Mount it after every
 * router and before the error handler.
 *
 * Without it Express serves an HTML page, and a client doing
 * `apiErrorSchema.parse(await res.json())` throws on the most ordinary failure
 * there is: a typo'd path, or a service worker replaying a route that no
 * longer exists.
 */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError())
}

class NotFoundError extends Error {
  readonly code: ApiErrorCode = "NOT_FOUND"
}

function isNotFound(err: unknown): err is NotFoundError {
  return err instanceof NotFoundError
}

export function createErrorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    // A partially written response cannot be replaced with an envelope; hand it
    // to Express, which will destroy the connection rather than emit a hybrid.
    if (res.headersSent) {
      next(err)
      return
    }

    const requestId = req.requestId ?? "unknown"
    const framework = bodyParserCode(err)

    let code: ApiErrorCode
    let message: string
    let details: FieldIssue[] | undefined

    if (err instanceof z.ZodError) {
      code = "VALIDATION_ERROR"
      message = FALLBACK_MESSAGE.VALIDATION_ERROR
      details = toFieldIssues(err, log, requestId)
    } else if (isNotFound(err)) {
      code = "NOT_FOUND"
      message = FALLBACK_MESSAGE.NOT_FOUND
    } else if (framework) {
      // A client-side mistake, so it is logged at `info`: an oversized body is
      // not an incident and must not page anyone.
      code = framework
      message = FALLBACK_MESSAGE[framework]
      log.info({ requestId, code, method: req.method }, "rejected a malformed request")
    } else if (isDomainError(err)) {
      code = err.code
      message = err.message || FALLBACK_MESSAGE[err.code]
      details = err.details ? [...err.details] : undefined
    } else {
      // Anything unrecognised is ours, not the caller's. The cause is logged
      // through the allowlisting error serializer and the response says nothing
      // beyond the correlation id (NFR-5.1, NFR-5.2).
      code = "INTERNAL"
      message = FALLBACK_MESSAGE.INTERNAL
      log.error({ requestId, err, method: req.method }, "Unhandled error while serving request")
    }

    const body: ApiError = {
      error: {
        code,
        message,
        requestId,
        ...(CODES_CARRYING_DETAILS.has(code) && details?.length ? { details } : {}),
      },
    }

    // Defence in depth: the server validates its own response against the same
    // schema the client parses it with.
    const validated = apiErrorSchema.safeParse(body)
    if (validated.success) {
      res.status(API_ERROR_STATUS[code]).json(validated.data)
      return
    }

    // Only `details` can realistically be malformed, so drop it and keep the
    // caller's real status. Downgrading a 400 to a retryable 500 here would
    // repeat the very inversion this handler exists to prevent.
    log.error(
      { requestId, issues: validated.error.issues },
      "Error envelope failed its own schema; retrying without details",
    )
    const stripped: ApiError = { error: { code, message, requestId } }
    const fallback = apiErrorSchema.safeParse(stripped)
    if (fallback.success) {
      res.status(API_ERROR_STATUS[code]).json(fallback.data)
      return
    }

    // The code itself was out of enum, so no envelope can describe it.
    res.status(API_ERROR_STATUS.INTERNAL).json({
      error: { code: "INTERNAL", message: FALLBACK_MESSAGE.INTERNAL, requestId },
    } satisfies ApiError)
  }
}
