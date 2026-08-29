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
  /**
   * FR-2.8's step-up, present only above `STEP_UP_THRESHOLD`.
   *
   * Optional in the schema and mandatory in the service, which is the right
   * way round: whether this transfer needs one depends on the amount, and a
   * schema that could express "required when another field exceeds a
   * constant" would still leave the server to check it. The rule lives once,
   * where the money moves.
   */
  password: z.string().min(1, { error: "field.required" }).optional(),
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

/**
 * What is left of FR-6.1's daily allowance, on the channel this client uses.
 *
 * 13.5 asks the amount step to show it, and F4 shipped without it because
 * nothing served it: the only client-side route to a figure is summing today's
 * outgoing transfers out of a paged history, which is right until somebody
 * makes more transfers in a day than one page holds and silently wrong after
 * that (P-32). A wrong allowance on a money screen is worse than an absent one.
 *
 * **A rolling twenty-four hours, not a calendar day**, because that is what the
 * server enforces — the limit check compares against `now - 24h`. A display
 * that reset at midnight would disagree with the refusal the user then
 * received, and that number would be worse than useless: authoritative-looking
 * and wrong.
 */
export const dailyAllowanceSchema = z.object({
  /*
   * `z.string()`, not `moneySchema`, and the difference is not cosmetic.
   * `moneySchema` is an *inbound* parser: it transforms to `bigint`, so a
   * response schema built from it validates fine and then hands `respond` an
   * object `JSON.stringify` refuses — a 500 on the balance screen. Every other
   * outbound amount here is a plain string for the same reason (12.2).
   */
  /** FR-6.1's ceiling for this channel. Minor units as a string (12.2). */
  limit: z.string(),
  /** Completed outgoing transfers on this channel in the last 24 hours. */
  spent: z.string(),
  /** `limit - spent`, floored at zero. Never negative, even after a limit change. */
  remaining: z.string(),
})
export type DailyAllowance = z.infer<typeof dailyAllowanceSchema>

export const accountsResponseSchema = z.object({
  accounts: z.array(accountSchema),
  /**
   * The web channel's limits, because this response is what the web reads.
   * USSD gets its own from the adapter, which has no screen to put them on.
   */
  limits: z.object({
    perOperation: z.string(),
    daily: dailyAllowanceSchema,
  }),
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

/**
 * `GET /api/transfers` — FR-5.
 *
 * The direction is its own word, and deliberately not `type`.
 *
 * §12.1 wrote the filter as `type=` while FR-5.2 defines it as
 * "incoming/outgoing", and the response already carries `type: P2P | TOPUP`.
 * One name for two concepts across the client/server boundary is the drift
 * that is cheap to prevent here and expensive to unpick once a client depends
 * on it, so the query parameter is `direction` and §12.1 was corrected.
 */
export const transferDirectionSchema = z.enum(["incoming", "outgoing"])
export type TransferDirection = z.infer<typeof transferDirectionSchema>

/** FR-5.1: 20 per page. Smaller pages exist for the home screen's last five. */
export const HISTORY_PAGE_MAX = 20

export const historyQuerySchema = z.object({
  /**
   * Opaque by contract, `createdAt|id` by construction. Clients must treat it
   * as a token: encoding meaning a client can parse invites one to build its
   * own, and then the server cannot change how pages are cut.
   */
  cursor: z.string().min(1).optional(),
  /** Inclusive lower bound on `createdAt`. */
  from: z.iso.datetime().optional(),
  /** Inclusive upper bound on `createdAt`. */
  to: z.iso.datetime().optional(),
  direction: transferDirectionSchema.optional(),
  status: transferStatusSchema.optional(),
  /*
   * Not in §12.1 originally. The home screen shows five rows (§13.3), and
   * fetching twenty to render five is twenty rows of bandwidth on the
   * connection NFR-3 exists for. Bounded so a client cannot ask for the table.
   */
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_MAX),
})
export type HistoryQuery = z.infer<typeof historyQuerySchema>

/**
 * One row of FR-5.3: date-time, counterparty, amount, status, and the id
 * support will ask for.
 *
 * `amount` is unsigned and `direction` carries the sign. The ledger already
 * works this way (§9.5) and a signed amount on the wire would let a client
 * render a negative incoming payment from a single flipped comparison.
 *
 * The counterparty is masked exactly as `FR-4.9`'s lookup masks it, and is
 * `null` for a top-up, where the other side is the treasury and naming it
 * would be describing plumbing to the user.
 */
export const historyItemSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  status: transferStatusSchema,
  type: transferTypeSchema,
  channel: transferChannelSchema,
  direction: transferDirectionSchema,
  amount: z.string(),
  counterparty: z
    .object({
      maskedName: z.string(),
      /**
       * Present only on a transfer this user sent (P-36).
       *
       * 13.5 asks for a recent-recipients quick pick, and a pick that cannot
       * fill the number field is a label. The masked name is deliberately not
       * enough to find somebody with — that is what FR-4.6 buys — so the list
       * needs the number itself.
       *
       * Outgoing only, and that is the whole disclosure argument: the user
       * typed this number, so returning it tells them nothing they did not
       * already have. On an *incoming* transfer the sender's number would be
       * new information about somebody who only chose to pay, so it stays
       * null and the row keeps its masked name.
       */
      phone: z.string().nullable(),
    })
    .nullable(),
})
export type HistoryItem = z.infer<typeof historyItemSchema>

export const historyResponseSchema = z.object({
  items: z.array(historyItemSchema),
  /** `null` on the last page (§12.2). */
  nextCursor: z.string().nullable(),
})
export type HistoryResponse = z.infer<typeof historyResponseSchema>
