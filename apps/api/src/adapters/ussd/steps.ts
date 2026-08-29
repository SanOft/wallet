/**
 * The USSD session, as a function of one string.
 *
 * There is no server-side session state, and that is the channel's defining
 * property rather than an omission: `text` accumulates every keypress of the
 * conversation, `*`-separated (FR-9.2), so each request arrives cold and
 * complete. A request that came twice, or out of order, or after the process
 * restarted, resolves to exactly the same step — which is what makes the
 * gateway's redelivery safe (§11.7).
 *
 * Pure by construction: no clock, no database, no I/O. Everything that can go
 * wrong in parsing is decided here and unit-tested without a fixture.
 */

/** One frame of §11.7's state machine, already told apart from its neighbours. */
export type UssdStep =
  /** Nothing typed yet. */
  | { readonly kind: "menu" }
  /** A choice that needs the PIN before it discloses anything (ADR-0010). */
  | { readonly kind: "ask-pin" }
  | { readonly kind: "balance"; readonly pin: string }
  | { readonly kind: "history"; readonly pin: string }
  /** Transfer chosen; who has not been said. */
  | { readonly kind: "ask-recipient" }
  /** A number typed. It is looked up so the sender sees who they are paying. */
  | { readonly kind: "quote-recipient"; readonly phone: string }
  /** An amount typed. Checked and echoed back before the PIN is asked for. */
  | { readonly kind: "quote-amount"; readonly phone: string; readonly amount: string }
  /** Everything is known and the PIN has been given. The only step that moves money. */
  | {
      readonly kind: "transfer"
      readonly phone: string
      readonly amount: string
      readonly pin: string
    }
  /** A sequence this menu never produces. */
  | { readonly kind: "unknown" }

const BALANCE = "1"
const TRANSFER = "2"
const HISTORY = "3"

/**
 * `"".split("*")` is `[""]`, not `[]`.
 *
 * Left as it comes, the opening request looks like a menu choice of the empty
 * string and falls through to `unknown` — so the very first screen of the
 * whole channel is an error message. Worth its own line.
 */
export function segmentsOf(text: string): readonly string[] {
  return text === "" ? [] : text.split("*")
}

export function resolveStep(text: string): UssdStep {
  const [choice, second, third, fourth, ...rest] = segmentsOf(text)

  // A fifth segment is not a step this menu can reach, whatever the first four
  // say. Checked before the branches so no branch has to remember to.
  if (rest.length > 0) return { kind: "unknown" }

  if (choice === undefined) return { kind: "menu" }

  if (choice === BALANCE || choice === HISTORY) {
    if (second === undefined) return { kind: "ask-pin" }
    if (third !== undefined) return { kind: "unknown" }
    return choice === BALANCE ? { kind: "balance", pin: second } : { kind: "history", pin: second }
  }

  if (choice === TRANSFER) {
    if (second === undefined) return { kind: "ask-recipient" }
    if (third === undefined) return { kind: "quote-recipient", phone: second }
    if (fourth === undefined) return { kind: "quote-amount", phone: second, amount: third }
    return { kind: "transfer", phone: second, amount: third, pin: fourth }
  }

  return { kind: "unknown" }
}
