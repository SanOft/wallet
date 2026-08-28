/**
 * When something happened, in the reader's own timezone.
 *
 * §12.2 sends ISO 8601 UTC and makes converting the client's job, so this is
 * that conversion — done once, here, rather than in each row that renders a
 * date.
 *
 * Numeric rather than named months. `Intl` has no guaranteed Uzbek month names
 * in every engine this has to run in, and a screen that falls back to English
 * month names inside an otherwise Uzbek interface looks broken in a way that
 * makes people distrust the numbers next to it.
 */

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

export function formatWhen(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    // A date we cannot read is not rendered as "Invalid Date" next to an
    // amount. An empty slot is honest; a broken one looks like the amount
    // might be broken too.
    return ""
  }

  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}, ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
