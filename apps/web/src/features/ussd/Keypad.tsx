import { Delete } from "lucide-react"

/**
 * The twelve keys a feature phone has.
 *
 * Not the accessible control — the text field above it is, and it is first in
 * the DOM for that reason. This is here because the thing being demonstrated
 * is a handset, and because on a desktop, where this page is actually read,
 * there is no numeric keyboard to bring up.
 *
 * Every key is a real button rather than a div with a click handler, so it is
 * reachable, focusable and announced without anything further being added.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const

/**
 * `*` and `#` are punctuation a screen reader will either skip or read as
 * "star" and "number sign" depending on verbosity settings, neither of which
 * is what the key is called. The digits need no help.
 */
const SPOKEN: Readonly<Record<string, string>> = {
  "*": "yulduzcha",
  "#": "panjara",
}

export function Keypad(props: {
  readonly onKey: (key: string) => void
  readonly onBackspace: () => void
  readonly disabled: boolean
}) {
  return (
    /*
      A real `fieldset` rather than `role="group"`. The keys are a set of
      controls inside a form and the element for that already exists; the
      legend is visually hidden because the group is unmistakable on sight and
      is exactly what a screen reader needs to be told before twelve buttons
      called "1" through "#".
    */
    /*
      Laid out with `style` rather than with Tailwind's grid utilities, and the
      reason is measurable rather than aesthetic.

      Tailwind emits one stylesheet for the whole application, so a utility
      used only by this lazily-loaded route still ships inside the
      render-blocking CSS on the login screen: **the route is code-split, its
      styles are not.** The ten utilities this page introduced added 389 bytes
      there and moved Lighthouse mobile performance from 98 to 97 — measured
      interleaved against `main`, nine pairs, the same result every time.
      Written inline the same declarations land in this chunk, which is
      downloaded only by somebody who opens the simulator, and the score
      returns.

      One trap worth knowing before undoing this: Tailwind v4 scans raw file
      text, so naming the removed classes in a comment regenerates them. Two of
      the ten came back from the sentence that explained their removal.
    */
    <fieldset
      className="gap-2xs"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        margin: 0,
        border: "none",
        padding: 0,
      }}
    >
      <legend className="sr-only">Raqam terish tugmalari</legend>

      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onKey(key)}
          aria-label={SPOKEN[key]}
          className="rounded-(--radius-control) border text-step-1 disabled:opacity-50"
          style={{
            minHeight: "var(--touch-target-min)",
            borderColor: "var(--color-neutral)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {key}
        </button>
      ))}

      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onBackspace}
        className="flex items-center justify-center gap-2xs rounded-(--radius-control) border text-step--1 disabled:opacity-50"
        style={{
          gridColumn: "span 3",
          minHeight: "var(--touch-target-min)",
          borderColor: "var(--color-neutral)",
        }}
      >
        <Delete size={16} aria-hidden={true} />
        O&apos;chirish
      </button>
    </fieldset>
  )
}
