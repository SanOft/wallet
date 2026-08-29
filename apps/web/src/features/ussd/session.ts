import { USSD_PIN_PROMPT, USSD_SESSION_TTL_MS } from "@wallet/shared"

/**
 * The simulator's half of FR-9.6, with no React, no clock and no network in
 * it.
 *
 * The governing idea is that **a gateway is dumb**. It mints a session id,
 * forwards whatever the subscriber typed, prints whatever comes back, and
 * knows nothing about the menu on the other side. Every piece of knowledge
 * this module does not have is a way the simulator cannot diverge from the
 * real thing — so `steps.ts`, which the adapter uses to decide what a given
 * `text` means, is deliberately not imported here. If this file understood the
 * menu it would be a second implementation of it, and the two would drift.
 *
 * What a gateway does know is the wire: that `text` accumulates (FR-9.2), that
 * a reply is `CON ` or `END ` (FR-9.3), and that the network kills an idle
 * session (FR-9.4). That is all this file models.
 */

/** FR-9.3, parsed. Anything else is not a USSD reply and must not be shown as one. */
export type Reply =
  | { readonly kind: "CON"; readonly text: string }
  | { readonly kind: "END"; readonly text: string }
  /**
   * The body did not begin with `CON ` or `END `.
   *
   * Kept as an outcome rather than thrown, because the honest thing to put on
   * screen is "this was not a USSD response" together with what did arrive. A
   * proxy's error page rendered inside the phone frame would be a lie told in
   * the one place built to show the protocol exactly.
   */
  | { readonly kind: "malformed"; readonly body: string }

export interface Exchange {
  /** What the subscriber typed for this turn. Empty on the opening dial. */
  readonly input: string
  /**
   * Whether that input was entered while the screen was asking for a PIN.
   *
   * Recorded at entry rather than derived later, and used only to decide what
   * this page prints. See `asksForPin`.
   */
  readonly secret: boolean
  readonly reply: Reply
}

export type SessionStatus =
  /** Waiting on the network. The previous screen must not be shown as current. */
  | "dialling"
  /** The last reply was `CON`: the network is holding the session open. */
  | "open"
  /** The last reply was `END`. */
  | "ended"
  /** No input for `USSD_SESSION_TTL_MS`. The network dropped it, not the server. */
  | "expired"
  /** The request never produced a reply — no network, a 5xx, a rejected session. */
  | "failed"

export interface Session {
  readonly id: string
  /** The accumulated `text` of FR-9.2, exactly as it goes on the wire. */
  readonly text: string
  readonly exchanges: readonly Exchange[]
  readonly status: SessionStatus
  /** When the last reply landed. The TTL runs from here, as the network's does. */
  readonly lastReplyAt: number
  /** Set only on `failed`, and shown as a gateway fault rather than as a reply. */
  readonly failure?: string
}

/**
 * `crypto.randomUUID` needs a secure context, which this app always has (§20.1
 * is HTTPS everywhere and localhost counts). One per dial, never reused: the
 * adapter derives its idempotency key from the session id and the text, so a
 * reused id would make a second transfer look like a redelivery of the first.
 */
export function newSession(now: number): Session {
  return {
    id: crypto.randomUUID(),
    text: "",
    exchanges: [],
    status: "dialling",
    lastReplyAt: now,
  }
}

/**
 * FR-9.2: the whole conversation travels on every request, `*`-separated.
 *
 * The opening dial sends `""`, so the first input becomes the entire text
 * rather than being appended to an empty segment — `"*1"` would parse as a
 * blank first choice followed by `1`, which is a different session.
 */
export function accumulate(text: string, input: string): string {
  return text === "" ? input : `${text}*${input}`
}

/** FR-9.3. The space after the keyword is part of the protocol, not formatting. */
export function parseReply(body: string): Reply {
  if (body.startsWith("CON ")) return { kind: "CON", text: body.slice(4) }
  if (body.startsWith("END ")) return { kind: "END", text: body.slice(4) }
  return { kind: "malformed", body }
}

/**
 * FR-9.4's 180 seconds, enforced by the simulator because it is enforced by
 * the network.
 *
 * There is no server-side session to expire — `text` carries the conversation
 * — so nothing upstream would stop a request typed an hour later, and the
 * adapter would answer it. A simulator that allowed that would be teaching the
 * opposite of how this channel behaves, on the one screen built to show how it
 * behaves.
 */
export function isExpired(session: Session, now: number): boolean {
  if (session.status !== "open") return false
  return now - session.lastReplyAt >= USSD_SESSION_TTL_MS
}

/** How long the network will still hold this open. `null` when nothing is counting down. */
export function remainingMs(session: Session, now: number): number | null {
  if (session.status !== "open") return null
  return Math.max(0, session.lastReplyAt + USSD_SESSION_TTL_MS - now)
}

/**
 * Whether the screen is asking for a PIN, read the way the person holding the
 * phone reads it — off the screen.
 *
 * This is a presentation heuristic and nothing more. It decides whether the
 * input is masked and whether the wire panel prints the digits, and both of
 * those are about what is shown, never about what is sent. Getting it wrong
 * reveals or hides four digits the user typed themselves; it cannot produce a
 * wrong request.
 *
 * The alternative was to import the adapter's state machine, which would make
 * the simulator smarter than any gateway is and give the protocol two
 * implementations to keep in step.
 *
 * The pattern itself lives in `packages/shared` rather than here. It used to be
 * written out in this file against copy written in `apps/api`, which this
 * workspace cannot import (§8.2) — so renaming the adapter's prompt would have
 * stopped the masking with nothing failing anywhere. `apps/api` now asserts its
 * prompts against it, and the rename fails there.
 */
export function asksForPin(reply: Reply | undefined): boolean {
  return reply?.kind === "CON" && USSD_PIN_PROMPT.test(reply.text)
}

/** The screen currently showing, or `undefined` before the first reply. */
export function currentReply(session: Session): Reply | undefined {
  return session.exchanges.at(-1)?.reply
}

/**
 * The `text` field as it goes on the wire, with the PIN hidden unless asked
 * for.
 *
 * Masked by default and revealable on request, because both halves are true
 * and the page has to say so: the PIN really is in this field, in clear, which
 * is the reason ADR-0010 exists — and printing it by default would put it in
 * every screenshot and every recording made of this screen.
 */
export function wireText(session: Session, reveal: boolean): string {
  if (reveal) return session.text
  return session.exchanges
    .filter((exchange) => exchange.input !== "")
    .map((exchange) => (exchange.secret ? "*".repeat(exchange.input.length) : exchange.input))
    .join("*")
}

/** Whether this session holds anything the reveal toggle would uncover. */
export function hasSecret(session: Session): boolean {
  return session.exchanges.some((exchange) => exchange.secret && exchange.input !== "")
}
