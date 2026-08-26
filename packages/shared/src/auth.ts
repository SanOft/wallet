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
})
export type PublicUser = z.infer<typeof publicUserSchema>

/** Refresh token travels in an httpOnly cookie, never in the body (FR-2.4). */
export const authResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: publicUserSchema,
})
export type AuthResponse = z.infer<typeof authResponseSchema>
