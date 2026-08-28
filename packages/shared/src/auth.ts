import * as z from "zod"
import { createRegionalPhoneSchema, DEFAULT_REGION } from "./phone.js"

/**
 * Password policy follows NIST SP 800-63B: length is the only rule.
 * No composition requirements (upper/digit/symbol) — in practice they reduce
 * entropy by pushing users toward predictable substitutions.
 * Minimum 15 because we ship without MFA in the MVP.
 */
export const PASSWORD_MIN_LENGTH = 15
export const PASSWORD_MAX_LENGTH = 64

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: "password.too_short" })
  .max(PASSWORD_MAX_LENGTH, { error: "password.too_long" })

/**
 * Unicode-aware personal name. \p{L} = any letter in any script,
 * \p{M} = combining marks. An ASCII-only rule would reject legitimate
 * names such as "Müller", "Иван" or "Gʻafur".
 */
const NAME_RE = /^\p{L}[\p{L}\p{M}\p{Zs}'‘’ʻʼ‛-]*$/u

export const nameSchema = z
  .string()
  .trim()
  .min(1, { error: "field.required" })
  .max(50, { error: "name.invalid" })
  .regex(NAME_RE, { error: "name.invalid" })

const phoneField = createRegionalPhoneSchema(DEFAULT_REGION)

/**
 * strictObject: unknown keys are REJECTED, not silently dropped.
 * For inbound requests an unexpected field means client and server
 * disagree — failing loudly is safer than guessing.
 */
export const registerRequestSchema = z.strictObject({
  phone: phoneField,
  firstName: nameSchema,
  lastName: nameSchema,
  password: passwordSchema,
})
export type RegisterRequest = z.infer<typeof registerRequestSchema>

/**
 * Login checks that a password is *present*, not that it meets today's policy.
 *
 * Reusing `passwordSchema` here gives the login endpoint a third response shape
 * — a per-field `password.too_short` — which contradicts FR-2.2's "the error
 * response is always identical", and short-circuits before any hash work, so it
 * is a free way to tell "reached the credential check" from "did not". It would
 * also lock existing accounts out at login the day the minimum is raised, which
 * is the wrong place to discover a policy change.
 */
export const loginPasswordSchema = z
  .string()
  .min(1, { error: "field.required" })
  .max(PASSWORD_MAX_LENGTH, { error: "password.too_long" })

export const loginRequestSchema = z.strictObject({
  phone: phoneField,
  password: loginPasswordSchema,
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * The ONLY shape a user may take on the wire.
 * passwordHash and pinHash are absent by construction: parsing a Prisma
 * record through this schema strips them (z.object strips unknown keys),
 * so a leak requires deleting this schema, not merely forgetting a field.
 */
export const publicUserSchema = z.object({
  id: z.string(),
  phone: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  /**
   * Whether a USSD PIN exists (FR-1.6) — never the PIN, never its hash.
   *
   * A property of the user rather than its own endpoint, because the Profile
   * screen already holds the user and a second round trip for one boolean is a
   * round trip on the connection NFR-3 is written for. It discloses nothing:
   * the only person who can read it is the account holder, and they know.
   */
  pinSet: z.boolean(),
})
export type PublicUser = z.infer<typeof publicUserSchema>

/** Refresh token travels in an httpOnly cookie, never in the body (FR-2.4). */
export const authResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: publicUserSchema,
})
export type AuthResponse = z.infer<typeof authResponseSchema>

/**
 * FR-9.5's four digits, and why they are only four.
 *
 * A PIN is not a password and is not asked to be: it guards the USSD channel,
 * where the keypad is a phone dialer and anything longer is unusable. Its
 * weakness is answered by the channel's own limits rather than by length —
 * three wrong attempts block transfers for an hour (FR-9.5), and USSD carries
 * a fraction of the web's per-operation cap (FR-6.1, NFR-1.11).
 *
 * Stored with the same Argon2id parameters as a password (NFR-1.1). Four
 * digits is ten thousand values; anything cheaper to verify would make the
 * hash the weak part rather than the PIN.
 */
export const pinSchema = z
  .string()
  .regex(/^\d{4}$/, { error: "pin.invalid_format" })
  .describe("Four digits")

/**
 * `PUT /api/me/pin` (FR-1.6, §12.1).
 *
 * The current password is required, and that is the whole security of this
 * endpoint: an access token is enough to *use* the wallet, and setting the PIN
 * that guards a second channel is a change only the account holder should be
 * able to make. A stolen token then buys the thief the web session they
 * already had, not a USSD one they did not.
 */
export const setPinRequestSchema = z.strictObject({
  currentPassword: z.string().min(1, { error: "field.required" }),
  pin: pinSchema,
})
export type SetPinRequest = z.infer<typeof setPinRequestSchema>

export const pinStatusResponseSchema = z.object({
  /** Whether a PIN exists — never the PIN, and never its hash. */
  isSet: z.boolean(),
})
export type PinStatusResponse = z.infer<typeof pinStatusResponseSchema>
