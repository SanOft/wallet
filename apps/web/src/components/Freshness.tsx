import { CloudOff, WifiOff } from "lucide-react"
import { type Freshness, formatAge, useAgeSeconds } from "../lib/freshness.js"

/**
 * The line under a number that says when it was true.
 *
 * Two registers, and the difference is deliberate. A confirmed figure gets
 * secondary text, because "updated a moment ago" is not news and should not
 * compete with the amount above it. An unconfirmed one gets the warning colour
 * §13.2.2 reserves for exactly this, an icon, and the reason — because the
 * user is now reading the past tense and nothing else on the screen says so.
 */

const REASON: Record<
  "offline" | "unreachable",
  { readonly text: string; readonly Icon: typeof WifiOff }
> = {
  // "No connection" and "could not reach the server" are different problems
  // with different fixes, and telling someone to check their internet when the
  // server is down wastes their time on a thing they cannot fix.
  offline: { text: "Aloqa yo'q", Icon: WifiOff },
  unreachable: { text: "Serverga ulanib bo'lmadi", Icon: CloudOff },
}

export function FreshnessLine(props: {
  readonly freshness: Freshness
  /** What the age describes, for anyone who cannot see what it sits under. */
  readonly label: string
}) {
  const { freshness, label } = props
  /*
   * Every state that puts a value on screen carries an age, so the exclusion
   * is the short list rather than the long one. Written the other way round —
   * naming the states that *have* an age — it silently returned `null` for
   * `checking` when that state was added, and the card said "hozirgina" about
   * an hour-old balance. The test caught it; the shape is what let it happen.
   */
  const asOf = freshness.kind === "loading" || freshness.kind === "absent" ? null : freshness.asOf
  const seconds = useAgeSeconds(asOf)

  if (freshness.kind === "loading" || freshness.kind === "absent") return null

  const age = formatAge(seconds)

  if (freshness.kind === "checking") {
    return (
      /*
       * Secondary text, not the warning colour: this is old data on its way to
       * being replaced, which is the ordinary way every cold start begins. The
       * age is still stated, because it is still what is on screen.
       */
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        <span className="sr-only">{label}: </span>
        {age}gi ma&apos;lumot — yangilanmoqda
      </p>
    )
  }

  if (freshness.kind === "current") {
    return (
      /*
       * No live region. This text changes every fifteen seconds on its own,
       * and a polite announcement of "two minutes ago" every quarter minute
       * makes a screen reader unusable — the one thing that would make this
       * app worse for the people it is meant to include.
       */
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        <span className="sr-only">{label}: </span>
        {age} yangilangan
      </p>
    )
  }

  const { text, Icon } = REASON[freshness.reason]

  return (
    <p
      /*
       * `status`, not `alert`: the connection dropping is worth announcing
       * once, at the next natural pause, but it is not an answer to something
       * the user just did and should not interrupt them mid-sentence.
       */
      role="status"
      className="m-0 flex items-center gap-2xs text-step--1"
      style={{ color: "var(--color-warning)" }}
    >
      <Icon size={16} aria-hidden={true} className="shrink-0" />
      <span>
        <span className="sr-only">{label}: </span>
        {text} — {age}gi ma&apos;lumot
      </span>
    </p>
  )
}
