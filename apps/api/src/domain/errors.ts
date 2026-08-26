import type { ApiErrorCode, FieldIssue } from "@wallet/shared"

/**
 * The domain's error vocabulary (spec §8.3).
 *
 * A domain error carries a stable `ApiErrorCode`, no HTTP status, no
 * `CON`/`END` prefix and no header. Turning one into a 422 or into
 * `END Insufficient funds` is the adapter's job.
 *
 * Stated honestly, because the isolation is partial: the domain reuses the API
 * code enum as its vocabulary rather than owning one of its own, and
 * `ApiErrorCode` lives next to the HTTP status map in the same shared file. So
 * the status is effectively decided in `packages/shared` and merely read by the
 * adapter. That is a deliberate one-adapter simplification and it is cheap to
 * undo today — six classes and one import. Revisit it at B6, when the USSD
 * adapter may want a granularity the HTTP shape does not share; the seam to
 * disagree at does not exist yet.
 *
 * Nothing in this file may import from `express`, and nothing in `adapters/`
 * may construct business rules. That direction is the whole point of §8.3.
 */
export class DomainError extends Error {
  readonly code: ApiErrorCode
  readonly details: readonly FieldIssue[] | undefined

  constructor(code: ApiErrorCode, message: string, details?: readonly FieldIssue[]) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

/** The request itself was well-formed but a field failed validation. */
export class ValidationError extends DomainError {
  constructor(details: readonly FieldIssue[]) {
    super("VALIDATION_ERROR", "Request validation failed", details)
  }
}

/**
 * Registration was refused. FR-1.5: the reason is deliberately not carried,
 * because "this number is taken" is a membership oracle — an attacker can walk
 * a number range and learn who banks here.
 */
export class RegistrationFailedError extends DomainError {
  constructor() {
    super("REGISTRATION_FAILED", "Registration failed")
  }
}

/**
 * FR-2.2: one error for a number that does not exist and for a wrong password.
 * The text is identical, the status is identical, and the caller spends the
 * same time on both — see `dummyHash` in infra/crypto.ts for the last part.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super("AUTH_INVALID_CREDENTIALS", "Invalid credentials")
  }
}

/** The refresh token is unknown, expired or already revoked. */
export class RefreshTokenInvalidError extends DomainError {
  constructor() {
    super("AUTH_TOKEN_EXPIRED", "Refresh token is not valid")
  }
}

/**
 * FR-2.7: a refresh token that has already been exchanged came back. Either the
 * client replayed it or someone stole it, and we cannot tell which — so the
 * whole family is revoked and every device signs in again.
 */
export class RefreshTokenReusedError extends DomainError {
  constructor() {
    super("AUTH_REFRESH_REUSED", "Refresh token reuse detected")
  }
}

/** Balance too low. Never says by how much — that is the caller's own balance to read. */
export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "Insufficient funds")
  }
}

/** An FR-6 limit was hit. `details` names which one. */
export class LimitExceededError extends DomainError {
  constructor(details?: readonly FieldIssue[]) {
    super("LIMIT_EXCEEDED", "Transfer limit exceeded", details)
  }
}

/** Lookup found nothing. Deliberately indistinguishable from "exists but hidden". */
export class RecipientNotFoundError extends DomainError {
  constructor() {
    super("RECIPIENT_NOT_FOUND", "Recipient not found")
  }
}

export class SelfTransferForbiddenError extends DomainError {
  constructor() {
    super("SELF_TRANSFER_FORBIDDEN", "Cannot transfer to your own account")
  }
}

/** Same idempotency key, different payload (FR-4.4). */
export class IdempotencyConflictError extends DomainError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different payload")
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError
}
