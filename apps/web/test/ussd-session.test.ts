import { USSD_SESSION_TTL_MS } from "@wallet/shared"
import { describe, expect, it } from "vitest"
import {
  accumulate,
  asksForPin,
  hasSecret,
  isExpired,
  parseReply,
  remainingMs,
  type Session,
  wireText,
} from "../src/features/ussd/session.js"

/**
 * The gateway half of FR-9.6, without a DOM.
 *
 * These are the rules that decide what goes on the wire, and every one of them
 * is a way the simulator could quietly stop being a simulator: a `text` that
 * accumulates wrongly is a different session, a reply parsed loosely is a proxy
 * page rendered as a message, and a TTL that does not fire is a channel
 * behaving in a way no real one does.
 */

function sessionAt(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    text: "",
    exchanges: [],
    status: "open",
    lastReplyAt: 0,
    ...overrides,
  }
}

describe("text accumulates (FR-9.2)", () => {
  it("makes the first input the whole text rather than appending to nothing", () => {
    /*
     * `"*1"` is not `"1"`. It parses as a blank first choice followed by `1`,
     * which reaches a different branch of the adapter's state machine — so
     * getting this wrong sends every session one step sideways.
     */
    expect(accumulate("", "1")).toBe("1")
  })

  it("carries the whole conversation on every later step", () => {
    expect(accumulate("2", "901234567")).toBe("2*901234567")
    expect(accumulate("2*901234567", "50000")).toBe("2*901234567*50000")
  })
})

describe("the CON/END prefix (FR-9.3)", () => {
  it("reads the two keywords and strips exactly the keyword", () => {
    expect(parseReply("CON Wallet\n1. Balans")).toEqual({
      kind: "CON",
      text: "Wallet\n1. Balans",
    })
    expect(parseReply("END Balans: 1 000 000 so'm")).toEqual({
      kind: "END",
      text: "Balans: 1 000 000 so'm",
    })
  })

  it("refuses a body that only looks like one", () => {
    /*
     * The space is part of the protocol. `CONTINUE` starts with `CON` and is
     * not a USSD reply, and a prefix check that ignored the space would render
     * "TINUE" on the phone screen as though the server had said it.
     */
    expect(parseReply("CONTINUE").kind).toBe("malformed")
    expect(parseReply("CON").kind).toBe("malformed")
  })

  it("treats anything else as not a reply at all, keeping what arrived", () => {
    // The realistic case: an origin misconfigured to answer /api with the
    // SPA's own index.html, served 200.
    const body = "<!doctype html><title>Wallet</title>"
    expect(parseReply(body)).toEqual({ kind: "malformed", body })
  })
})

describe("the 180-second session (FR-9.4)", () => {
  it("expires an open session the network would have dropped", () => {
    const session = sessionAt({ lastReplyAt: 0 })

    expect(isExpired(session, USSD_SESSION_TTL_MS - 1)).toBe(false)
    expect(isExpired(session, USSD_SESSION_TTL_MS)).toBe(true)
  })

  it("does not expire a session that has already ended", () => {
    // Nothing is being held open, so there is nothing for the network to drop.
    // Without this an ended session would flip to "expired" three minutes
    // later and tell the user their completed transfer had timed out.
    const ended = sessionAt({ status: "ended", lastReplyAt: 0 })
    expect(isExpired(ended, USSD_SESSION_TTL_MS * 10)).toBe(false)
  })

  it("counts down and floors at zero rather than going negative", () => {
    const session = sessionAt({ lastReplyAt: 0 })
    expect(remainingMs(session, 0)).toBe(USSD_SESSION_TTL_MS)
    expect(remainingMs(session, USSD_SESSION_TTL_MS + 5000)).toBe(0)
  })

  it("reports no countdown when nothing is counting", () => {
    expect(remainingMs(sessionAt({ status: "ended" }), 0)).toBeNull()
  })
})

describe("what the wire panel prints", () => {
  const withPin = sessionAt({
    text: "2*901234567*50000*1234",
    exchanges: [
      { input: "", secret: false, reply: { kind: "CON", text: "menu" } },
      { input: "2", secret: false, reply: { kind: "CON", text: "raqam" } },
      { input: "901234567", secret: false, reply: { kind: "CON", text: "summa" } },
      { input: "50000", secret: false, reply: { kind: "CON", text: "PIN kodni kiriting" } },
      { input: "1234", secret: true, reply: { kind: "END", text: "yuborildi" } },
    ],
  })

  it("hides the PIN by default and nothing else", () => {
    /*
     * The recipient and the amount stay legible: masking them would hide the
     * thing this panel exists to show, which is that the whole conversation
     * travels on every request.
     */
    expect(wireText(withPin, false)).toBe("2*901234567*50000*****")
  })

  it("shows it when asked, because that is the truth about this channel", () => {
    expect(wireText(withPin, true)).toBe("2*901234567*50000*1234")
  })

  it("offers no reveal on a session that never carried one", () => {
    const balance = sessionAt({
      exchanges: [{ input: "1", secret: false, reply: { kind: "CON", text: "PIN" } }],
    })
    expect(hasSecret(balance)).toBe(false)
    expect(hasSecret(withPin)).toBe(true)
  })
})

describe("reading the screen for a PIN prompt", () => {
  it("masks the next input when the screen asks for one", () => {
    expect(asksForPin({ kind: "CON", text: "PIN kodni kiriting" })).toBe(true)
    expect(asksForPin({ kind: "CON", text: "Tasdiqlash uchun PIN kodni kiriting" })).toBe(true)
  })

  it("does not mask an ordinary prompt", () => {
    expect(asksForPin({ kind: "CON", text: "Summa (so'm)" })).toBe(false)
    expect(asksForPin(undefined)).toBe(false)
  })

  it("never masks after a finished session", () => {
    // An `END` that happens to mention the word is not a prompt — there is
    // nothing left to type.
    expect(asksForPin({ kind: "END", text: "PIN noto'g'ri." })).toBe(false)
  })
})
