/**
 * A sliding count per key, in memory.
 *
 * Stated plainly, because it is the same weak control `routes/recipients.ts`
 * describes for FR-4.9: the counter resets when the process restarts and is
 * not shared between instances. Render's free tier runs one instance (§20.3).
 *
 * That file holds a near-identical window inline. This one is written as a
 * class rather than copied so the two can collapse into one when the
 * `AccountService` extraction (P-19) moves the lookup out of the route — a
 * second hand-rolled copy is how the web and USSD channels come to disagree
 * about what FR-4.9's twenty means.
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
