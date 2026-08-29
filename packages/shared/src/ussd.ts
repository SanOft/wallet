import * as z from "zod"
import { normalizePhone, phoneSchema } from "./phone.js"

/**
 * The USSD gateway callback (FR-9.1), shared because two sides speak it: the
 * adapter that answers it and the simulator that produces it (FR-9.6).
 *
 * Only the request shape lives here. The *response* is plain text prefixed
 * `CON ` or `END ` (FR-9.3) — not JSON, not a schema, and the one thing about
 * this channel a Zod type cannot describe.
 */

/**
 * 182 characters, and the number is not arbitrary: a USSD string is 160 octets,
 * and the GSM 7-bit default alphabet packs (160 * 8) / 7 = 182 septets into
 * them (3GPP TS 23.038).
 *
 * The corollary is the part that bites. 182 holds *only* while every character
 * is in that alphabet; one character outside it switches the whole string to
 * UCS-2 and the limit collapses to 70. A recipient named "Иван" therefore
 * silently truncates a message that measured 120 characters — which is why
 * `toGsm7` exists on the adapter side rather than being assumed.
 */
export const USSD_MAX_SEPTETS = 182

/** FR-9.5. Four digits, and nothing else is a wrong PIN — it is a typo. */
export const USSD_PIN_LENGTH = 4

/**
 * How a screen says it is asking for a PIN.
 *
 * Shared because two sides depend on it and neither can see the other: the
 * adapter writes the prompt, and F7's simulator reads it off the screen to
 * decide whether to mask what is typed next — the same signal the person
 * holding the phone uses, and deliberately the *only* protocol knowledge the
 * simulator has (a gateway that understood the menu would be a second
 * implementation of it).
 *
 * The coupling was previously a regex written out in the browser against copy
 * written in the API, in a different workspace that cannot import it. Changing
 * the adapter's wording would have silently stopped the masking, with nothing
 * failing. `apps/api` now asserts its prompts against this pattern, so the
 * rename fails there instead.
 */
export const USSD_PIN_PROMPT = /\bPIN\b/i

/**
 * The session dies after this long without input (FR-9.4).
 *
 * Enforced by the network, not by us: there is no server-side session to
 * expire, because `text` carries the whole conversation on every request. The
 * constant is here so the simulator can behave like the network does.
 */
export const USSD_SESSION_TTL_MS = 180_000

/**
 * FR-9.4's hard bound: a reply the gateway is still willing to wait for.
 *
 * The same requirement names 3 s as the target, and that number is deliberately
 * not a constant here — it is measured against a running server and recorded in
 * the runbook, because a CPU-time assertion on shared CI hardware is a flaky
 * test rather than a guarantee. This is the bound a regression has to break to
 * matter: at it, the subscriber has already pressed the key again.
 */
export const USSD_RESPONSE_CEILING_MS = 10_000

export const ussdCallbackSchema = z.strictObject({
  sessionId: z.string().min(1, { error: "field.required" }).max(64),
  /*
   * Normalised before validation because gateways disagree about the leading
   * `+` and about whether the country code is included at all. Rejecting a
   * subscriber over a formatting convention would be a dead channel for
   * whoever's gateway sends the other shape.
   */
  phoneNumber: z
    .string()
    .trim()
    .transform((raw) => normalizePhone(raw))
    .pipe(phoneSchema),
  networkCode: z.string().max(16),
  /*
   * Both of these are parsed and then ignored, deliberately.
   *
   * Requiring them keeps the contract honest — a gateway that stops sending
   * one has changed its protocol and should fail loudly here rather than three
   * layers in. Branching on them would mean a second shortcode and a second
   * network as configuration this service has no second value for.
   */
  serviceCode: z.string().max(16),
  /**
   * The accumulated input, `*`-separated (FR-9.2).
   *
   * Capped because it is the only unbounded field, and it is split on every
   * request: the longest legitimate session here is
   * `2*901234567*1000000000*1234`, 27 characters.
   */
  text: z.string().max(160),
})

export type UssdCallback = z.infer<typeof ussdCallbackSchema>
