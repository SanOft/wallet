import {
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  apiErrorSchema,
  type FieldIssue,
  fieldErrorCodeSchema,
} from "@wallet/shared"
import type { ErrorRequestHandler } from "express"
import * as z from "zod"
import { isDomainError } from "../../../domain/errors.js"
import type { Logger } from "../../../infra/logger.js"

/**
 * The single place a failure becomes an HTTP response (spec §12.3).
 *
 * `code` is the contract; `message` is a fallback for logs and debugging, and
 * the client is expected to render its own text from the code. The status is
 * read from API_ERROR_STATUS in @wallet/shared rather than written here, so the
 * two cannot drift apart.
 */

/** Debugging fallbacks. The user-facing text is the client's job (§12.3). */
const FALLBACK_MESSAGE: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: "Request validation failed",
  REGISTRATION_FAILED: "Registration failed",
  AUTH_INVALID_CREDENTIALS: "Invalid credentials",
  AUTH_TOKEN_EXPIRED: "Access token expired",
  AUTH_REFRESH_REUSED: "Refresh token reuse detected",
  AUTH_LOCKED: "Account temporarily locked",
  RATE_LIMITED: "Too many requests",
  RECIPIENT_NOT_FOUND: "Recipient not found",
  SELF_TRANSFER_FORBIDDEN: "Cannot transfer to your own account",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  LIMIT_EXCEEDED: "Transfer limit exceeded",
  IDEMPOTENCY_CONFLICT: "Idempotency key reused with a different payload",
  PIN_NOT_SET: "PIN is not set",
  PIN_LOCKED: "PIN is locked",
  INTERNAL: "Internal error",
}

/**
 * Our shared schemas carry their field code as the Zod issue message
 * (`{ error: "phone.invalid_format" }`), so a well-formed issue maps directly.
 *
 * An issue whose message is not in the closed field-code enum is a defect in the
 * schema that produced it, not something to paper over: inventing a plausible
 * code here would ship a lie to the client. Such issues are dropped from the
 * response and reported at `warn` so the schema gets fixed.
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
    }
  }

  return mapped
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

    let code: ApiErrorCode
    let message: string
    let details: FieldIssue[] | undefined

    if (err instanceof z.ZodError) {
      code = "VALIDATION_ERROR"
      message = FALLBACK_MESSAGE.VALIDATION_ERROR
      details = toFieldIssues(err, log, requestId)
    } else if (isDomainError(err)) {
      code = err.code
      message = err.message || FALLBACK_MESSAGE[err.code]
      details = err.details ? [...err.details] : undefined
    } else {
      // Anything unrecognised is ours, not the caller's. The cause is logged in
      // full and the response says nothing beyond the correlation id (NFR-5.1).
      code = "INTERNAL"
      message = FALLBACK_MESSAGE.INTERNAL
      log.error(
        { requestId, err, method: req.method, path: req.path },
        "Unhandled error while serving request",
      )
    }

    // `details` belongs to VALIDATION_ERROR alone (§12.3).
    const body: ApiError = {
      error: {
        code,
        message,
        requestId,
        ...(code === "VALIDATION_ERROR" && details ? { details } : {}),
      },
    }

    // Defence in depth: the server validates its own response against the same
    // schema the client parses it with. A malformed envelope becomes a 500 here
    // rather than a parse failure in the browser.
    const validated = apiErrorSchema.safeParse(body)
    if (!validated.success) {
      log.error(
        { requestId, issues: validated.error.issues },
        "Error envelope failed its own schema; responding with a bare INTERNAL",
      )
      res.status(API_ERROR_STATUS.INTERNAL).json({
        error: { code: "INTERNAL", message: FALLBACK_MESSAGE.INTERNAL, requestId },
      } satisfies ApiError)
      return
    }

    res.status(API_ERROR_STATUS[code]).json(validated.data)
  }
}
