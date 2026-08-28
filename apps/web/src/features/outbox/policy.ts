/**
 * FR-8.4's retry policy, on its own, so it can be reasoned about and tested
 * without a network, a store, or a clock.
 *
 * The rule that matters is the negative one: **a 4xx is never retried.** A
 * rejected request is not a request that needs another go — it is one the
 * server understood and refused, and repeating it burns the daily top-up
 * allowance, trips the rate limiter, and turns one clear error into a
 * background process the user cannot see or stop. §12.3 states the same thing
 * from the server's side: 4xx means the request itself is wrong.
 *
 * `IDEMPOTENCY_CONFLICT` deserves naming, because it is the one 4xx that looks
 * retryable and is the most dangerous to retry. It means this key already
 * carried a *different* payload, so trying again cannot succeed and each
 * attempt is a fresh write attempt against money.
 */

/** 1s, 2s, 4s, 8s — four waits, so five attempts in total (FR-8.4). */
export const BACKOFF_MS = [1000, 2000, 4000, 8000] as const

export const MAX_ATTEMPTS = BACKOFF_MS.length + 1

export type Outcome =
  /** Gone through. Remove it and let the screens refetch. */
  | { readonly kind: "sent" }
  /** Refused, understood, final. Never sent again. */
  | { readonly kind: "rejected"; readonly code: string | null }
  /** Nobody answered, or the server broke. Worth another go, if any are left. */
  | { readonly kind: "retryable" }

/**
 * What a completed attempt means.
 *
 * `status` is `null` when the request never reached a server at all — a dropped
 * connection, a DNS failure, a radio that switched off mid-flight. That is the
 * most retryable case there is and the one this whole feature exists for.
 */
export function classify(status: number | null, code: string | null): Outcome {
  if (status === null) return { kind: "retryable" }
  if (status >= 200 && status < 300) return { kind: "sent" }

  // 5xx: ours, and 12.3 marks it retryable precisely because idempotency makes
  // repeating it safe.
  if (status >= 500) return { kind: "retryable" }

  /*
   * 429 is a 4xx and is deliberately *not* retried here.
   *
   * It is the one arguable case: the server is asking for a delay rather than
   * refusing outright. But this queue drains without anyone watching, and a
   * client that answers "too many requests" with more requests is the
   * behaviour rate limiting exists to stop. The user is told, and they decide.
   */
  return { kind: "rejected", code }
}

/** How long before attempt number `attempts + 1`. `null` when the budget is spent. */
export function waitBefore(attempts: number): number | null {
  return BACKOFF_MS[attempts - 1] ?? null
}
