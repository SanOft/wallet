import { WifiOff } from "lucide-react"
import { useOnline } from "../lib/freshness.js"

/**
 * §13.3's offline banner: the condition, stated once, for as long as it holds.
 *
 * A banner rather than a notification, and the distinction is the whole point.
 * A toast disappears after a few seconds; the connection does not. Anything
 * that vanishes on a timer is the wrong channel for a fact the user needs
 * while reading the rest of the screen — and for someone using a screen
 * reader, a message that has already gone is a message that never existed.
 *
 * It says the condition; the freshness line under each figure says the
 * consequence — how old that particular number is. Repeating "no connection"
 * beside every card, which is what F3 shipped, made the same sentence appear
 * three times and still left the screen without a single place that said what
 * was wrong.
 */
export function ConnectionBanner() {
  const online = useOnline()

  if (online) return null

  return (
    <p
      /*
       * `status`, not `alert`. Losing the connection is worth announcing at
       * the next pause; it is not an answer to something the user just did,
       * and interrupting them mid-sentence to say it would be rude in exactly
       * the situation where they are least able to recover their place.
       */
      role="status"
      className="m-0 flex items-center justify-center gap-2xs px-s py-2xs text-step--1"
      style={{ background: "var(--color-surface-sunken)", color: "var(--color-warning)" }}
    >
      <WifiOff size={16} aria-hidden={true} className="shrink-0" />
      <span>Aloqa yo&apos;q. Raqamlar oxirgi ma&apos;lum holatni ko&apos;rsatmoqda.</span>
    </p>
  )
}
