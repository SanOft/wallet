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
  createdAt: z.string(),
  completedAt: z.string().nullable(),
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
  .string()
  .uuid({ error: "field.required" })
  .describe("Idempotency-Key header")
