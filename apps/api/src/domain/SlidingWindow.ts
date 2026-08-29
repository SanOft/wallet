/**
 * A sliding count per key, in memory.
 *
 * Stated plainly, because it is the weakest control in FR-4.9: the counter
 * resets when the process restarts and is not shared between instances.
 * Render's free tier runs one instance (§20.3) and sleeps after inactivity,
 * so a determined enumerator could wait out a cold start. Moving it to a
 * shared store belongs with the wider rate limiting (P-22).
 *
 * In the domain rather than beside a channel, because that is where the rule
 * it enforces lives now. It was written as a class in `adapters/ussd` so the
 * near-identical window inlined in `routes/recipients.ts` could collapse into
 * it (P-34); `AccountService` owns the single remaining instance, so the web
 * and USSD channels can no longer come to disagree about what FR-4.9's twenty
 * means.
 */
export class SlidingWindow {
  readonly #limit: number
  readonly #windowMs: number
  readonly #hits = new Map<string, number[]>()
  #lastEvictionAt = 0

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Records a hit and reports whether it was within budget. */
  admit(key: string, now: number): boolean {
    this.#evict(now)

    const recent = (this.#hits.get(key) ?? []).filter((at) => at > now - this.#windowMs)

    if (recent.length >= this.#limit) {
      // Written back, so the expired entries are dropped even on the refusal
      // path; otherwise a caller who keeps hitting the limit keeps their whole
      // history forever.
      this.#hits.set(key, recent)
      return false
    }

    recent.push(now)
    this.#hits.set(key, recent)
    return true
  }

  /** Exposed so a test starts from a known state rather than a shared one. */
  reset(): void {
    this.#hits.clear()
    this.#lastEvictionAt = 0
  }

  /**
   * Without this the map only ever grows: the only code that touches an entry
   * is the same caller's next request, so a caller who never returns keeps
   * their key for the life of the process.
   *
   * Swept at most once a minute, so a burst does not pay for it per request.
   */
  #evict(now: number): void {
    if (now - this.#lastEvictionAt < 60_000) return
    this.#lastEvictionAt = now

    for (const [key, timestamps] of this.#hits) {
      if (timestamps.every((at) => at <= now - this.#windowMs)) this.#hits.delete(key)
    }
  }
}
