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

import { reportError } from "./report.js"

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

export function formatWhen(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    // Not rendered as "Invalid Date" next to an amount: an empty slot is
    // honest, a broken one makes the amount beside it look suspect too. But
    // the server promised ISO 8601 (§12.2), so an unreadable value is a
    // contract fault and saying nothing about it would leave a blank column
    // nobody could explain.
    reportError("datetime:unreadable", new Error("value is not a date"), { value: iso })
    return ""
  }

  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}, ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
