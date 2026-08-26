import * as z from "zod"
import { moneySchema } from "./money.js"
import { createRegionalPhoneSchema, DEFAULT_REGION } from "./phone.js"

/**
 * The money-transfer contract (FR-4, §12.2).
 *
 * Amounts cross the wire as **strings** in minor units, never as numbers. A
 * `BigInt` has no JSON representation at all, and a value above 2^53 loses
 * precision the moment it becomes a `number` — which for tiyin is about
 * 90 billion so'm, close enough to a real balance to matter.
 */

const phoneField = createRegionalPhoneSchema(DEFAULT_REGION)

/**
 * `strictObject`: an unexpected field means the client and server disagree
 * about the contract, and failing loudly is safer than guessing which one is
 * right (the same reasoning as the auth requests).
 */
export const transferRequestSchema = z.strictObject({
  /** The recipient's number in E.164 (FR-4.1). */
  phone: phoneField,
  /** Minor units as a canonical decimal string; `moneySchema` parses it. */
  amount: moneySchema,
})
export type TransferRequest = z.infer<typeof transferRequestSchema>

/**
 * `POST /api/accounts/topup` takes nothing: FR-10.1 fixes the amount and the
 * account comes from the token. Strict, so a client that thinks it chooses
 * either is told rather than silently ignored.
 */
export const topUpRequestSchema = z.strictObject({})

export const transferStatusSchema = z.enum(["PENDING", "COMPLETED", "FAILED"])
export type TransferStatus = z.infer<typeof transferStatusSchema>

export const transferChannelSchema = z.enum(["WEB", "USSD"])
export const transferTypeSchema = z.enum(["P2P", "TOPUP"])

/** Every amount here is a string in minor units (§12.2). */
export const transferResponseSchema = z.object({
  id: z.string(),
  status: transferStatusSchema,
  amount: z.string(),
  channel: transferChannelSchema,
  type: transferTypeSchema,
  /** ISO 8601 UTC, produced by the server; the client clock is never used (D-10). */
  // `z.iso.datetime()` rather than a bare string: §12.2 says ISO 8601 UTC, and
  // a bare `z.string()` let `Date.prototype.toString()` through unnoticed —
  // `respond()` validates against this schema, so the schema is the check.
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  failReason: z.string().nullable(),
  /** The sender's balance after this transfer, so the client need not re-fetch. */
  senderBalanceAfter: z.string(),
})
export type TransferResponse = z.infer<typeof transferResponseSchema>

/**
 * FR-4.4: a client-generated UUID v4, mandatory on every money-moving POST.
 * Validated as a header rather than a body field because it identifies the
 * *request*, not the transfer.
 */
export const idempotencyKeySchema = z
  // v4 specifically (§12.2). `z.uuid()` accepts every version including the
  // nil UUID, so a client bug sending all zeroes would get exactly one
  // successful transfer and then `IDEMPOTENCY_CONFLICT` forever.
  .uuidv4({ error: "field.required" })
  .describe("Idempotency-Key header")

/**
 * `GET /api/accounts` (FR-3, §12.1). One UZS account in the MVP, but the shape
 * is a list so adding a currency in v2 is not a breaking change (§21 Q-3).
 */
export const accountSchema = z.object({
  id: z.string(),
  currency: z.string(),
  /** Minor units as a string (§12.2). */
  balance: z.string(),
  type: z.enum(["USER", "TREASURY"]),
})

export const accountsResponseSchema = z.object({
  accounts: z.array(accountSchema),
  user: z.object({
    id: z.string(),
    phone: z.string(),
    firstName: z.string(),
    lastName: z.string(),
  }),
})
export type AccountsResponse = z.infer<typeof accountsResponseSchema>

/**
 * `GET /api/recipients/lookup` (FR-4.9).
 *
 * The name is masked before it leaves the server, so the response cannot be
 * used to harvest full names by walking a number range. Only an exact,
 * complete-number match returns anything at all.
 */
export const recipientLookupSchema = z.object({
  phone: z.string(),
  /** `MUHAMMADALI T.` — given name, then the family initial. */
  maskedName: z.string(),
})
export type RecipientLookup = z.infer<typeof recipientLookupSchema>

/**
 * Masks a name for the confirmation screen (FR-4.6, §11.4).
 *
 * Lives in `shared` because both the API and the USSD adapter render it, and a
 * second implementation would drift — one of them would eventually show a
 * full surname.
 */
export function maskRecipientName(firstName: string, lastName: string): string {
  const given = firstName.trim().toUpperCase()
  const initial = firstCodePointUpper(lastName.trim())

  if (!initial) return given
  if (!given) return `${initial}.`
  return `${given} ${initial}.`
}

/**
 * The first *code point*, uppercased, and only one of it.
 *
 * Two real bugs lived in the one-line version this replaces.
 *
 * `charAt(0)` returns a UTF-16 code unit, not a character. `nameSchema`
 * accepts astral letters because they match the Unicode letter class, so a
 * surname starting above the BMP put an unpaired surrogate on the wire — an
 * ill-formed Unicode string in a production JSON body.
 *
 * And `toUpperCase` is not length-preserving: the German sharp s uppercases to
 * two letters, so the mask published twice what it promised. Taking the first
 * code point *after* uppercasing fixes both at once.
 */
function firstCodePointUpper(value: string): string {
  const [first] = [...value]
  if (!first) return ""
  const [upper] = [...first.toUpperCase()]
  return upper ?? ""
}
