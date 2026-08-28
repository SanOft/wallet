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
 * The session dies after this long without input (FR-9.4).
 *
 * Enforced by the network, not by us: there is no server-side session to
 * expire, because `text` carries the whole conversation on every request. The
 * constant is here so the simulator can behave like the network does.
 */
export const USSD_SESSION_TTL_MS = 180_000

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
