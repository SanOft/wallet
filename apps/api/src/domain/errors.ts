import type { ApiErrorCode, FieldIssue } from "@wallet/shared"

/**
 * The domain's error vocabulary (spec §8.3).
 *
 * A domain error carries a stable `ApiErrorCode` and nothing else about
 * transport: no HTTP status, no `CON`/`END` prefix, no header. Turning one into
 * a 422 or into `END Insufficient funds` is the adapter's job, which is what
 * lets the USSD channel plug in later without touching this layer.
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
