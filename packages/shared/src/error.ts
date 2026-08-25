import * as z from "zod"

/**
 * Two distinct kinds of error identity:
 *
 *  1. API error codes  — the whole request failed. One per response.
 *  2. Field error codes — a specific field is wrong. Many per response,
 *                         always nested inside VALIDATION_ERROR.
 *
 * Both are stable, language-independent identifiers. Human text is produced
 * by the client from these codes, never taken from the wire.
 */

export const apiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "REGISTRATION_FAILED",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_TOKEN_EXPIRED",
  "AUTH_REFRESH_REUSED",
  "AUTH_LOCKED",
  "RATE_LIMITED",
  "RECIPIENT_NOT_FOUND",
  "SELF_TRANSFER_FORBIDDEN",
  "INSUFFICIENT_FUNDS",
  "LIMIT_EXCEEDED",
  "IDEMPOTENCY_CONFLICT",
  "PIN_NOT_SET",
  "PIN_LOCKED",
  "INTERNAL",
])
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

export const fieldErrorCodeSchema = z.enum([
  "phone.invalid_format",
  "phone.unsupported_region",
  "phone.invalid_length",
  "money.invalid_format",
  "money.below_minimum",
  "money.above_maximum",
  "money.invalid_step",
  "password.too_short",
  "password.too_long",
  "name.invalid",
  "field.required",
])
export type FieldErrorCode = z.infer<typeof fieldErrorCodeSchema>

/** One invalid field. `path` mirrors Zod's issue path, e.g. ["phone"]. */
export const fieldIssueSchema = z.object({
  path: z.array(z.string()),
  code: fieldErrorCodeSchema,
})
export type FieldIssue = z.infer<typeof fieldIssueSchema>

/** The single error envelope every failing endpoint returns (spec §12.3). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    /** Human-readable fallback. Clients prefer `code`. */
    message: z.string(),
    /** Correlates the response with server logs (NFR-5.1). */
    requestId: z.string(),
    /** Present only when code === 'VALIDATION_ERROR'. */
    details: z.array(fieldIssueSchema).optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

/** Transport mapping. Kept next to the codes so the two cannot drift apart. */
export const API_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  REGISTRATION_FAILED: 400,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_REFRESH_REUSED: 401,
  AUTH_LOCKED: 429,
  RATE_LIMITED: 429,
  RECIPIENT_NOT_FOUND: 404,
  SELF_TRANSFER_FORBIDDEN: 422,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  PIN_NOT_SET: 422,
  PIN_LOCKED: 429,
  INTERNAL: 500,
} as const satisfies Record<ApiErrorCode, number>

/**
 * Retry policy (FR-8.4): only server faults may be retried.
 * A 4xx means the request itself is wrong — repeating it changes nothing.
 */
export function isRetryable(code: ApiErrorCode): boolean {
  return API_ERROR_STATUS[code] >= 500
}
