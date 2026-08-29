import {
  type RecipientLookup,
  recipientLookupSchema,
  type TransferResponse,
  transferResponseSchema,
} from "@wallet/shared"
import { walletApi } from "../../app/api.js"
import { parseResponse } from "../../lib/parseResponse.js"

/**
 * FR-4.9's lookup and FR-4's transfer.
 *
 * The lookup is a query rather than a mutation even though it is
 * rate-limited (twenty per hour), because it reads: making it a mutation to
 * signal "this is expensive" would give up caching and re-ask the server every
 * time the user stepped back to check the name.
 */
/**
 * The wire shape, not the parsed one.
 *
 * `TransferRequest` is what `transferRequestSchema` produces — and it produces
 * `amount: bigint`, because `moneySchema` parses the canonical string into one
 * for the domain to do arithmetic with. What travels is a string (§12.2), so
 * the mutation takes a string; converting to bigint here only to convert back
 * during serialisation would be a round trip through a type that JSON cannot
 * represent anyway.
 */
export interface CreateTransferArgs {
  readonly phone: string
  /** Minor units, canonical decimal string. */
  readonly amount: string
  /** FR-2.8, present only above the threshold. */
  readonly password?: string
  readonly idempotencyKey: string
}

export const transferApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    lookupRecipient: build.query<RecipientLookup, string>({
      query: (phone) => ({ url: "/recipients/lookup", params: { phone } }),
      transformResponse: parseResponse(recipientLookupSchema, "recipients"),
      /*
       * Not tagged, and so never invalidated by a transfer. A masked name does
       * not change when money moves, and re-fetching it would spend one of the
       * twenty hourly lookups on an answer already held.
       */
    }),

    createTransfer: build.mutation<TransferResponse, CreateTransferArgs>({
      query: ({ idempotencyKey, ...body }) => ({
        url: "/transfers",
        method: "POST",
        // Supplied by the caller so a retry reuses it (FR-4.4). The wizard
        // mints one when the confirmation screen opens, not when Send is
        // pressed — a double-tap must not produce two keys.
        headers: { "idempotency-key": idempotencyKey },
        body,
      }),
      transformResponse: parseResponse(transferResponseSchema, "transfers"),
      invalidatesTags: ["Accounts", "History"],
    }),
  }),
})

export const { useLazyLookupRecipientQuery, useCreateTransferMutation } = transferApi
