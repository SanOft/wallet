import {
  type AccountsResponse,
  accountsResponseSchema,
  type TransferResponse,
} from "@wallet/shared"
import { walletApi } from "../../app/api.js"
import { parseResponse } from "../../lib/parseResponse.js"

/**
 * FR-3 and FR-10, typed by the same contract the server validates with.
 */
export const accountsApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    accounts: build.query<AccountsResponse, void>({
      query: () => "/accounts",
      transformResponse: parseResponse(accountsResponseSchema, "accounts"),
      providesTags: ["Accounts"],
    }),

    topUp: build.mutation<TransferResponse, { idempotencyKey: string }>({
      query: ({ idempotencyKey }) => ({
        url: "/accounts/topup",
        method: "POST",
        headers: {
          /*
           * FR-4.4's key, supplied by the caller rather than minted here.
           *
           * It used to be generated inside `query`, on the reasoning that
           * nothing upstream should be able to hand in a used one. F6.3
           * overturns that: a queued request is retried, and a retry that
           * mints a fresh key is a second top-up rather than another attempt
           * at the first. The key has to outlive the attempt, so it belongs to
           * whoever owns the attempt.
           *
           * `newIdempotencyKey()` is the only place one is made, which keeps
           * the original guarantee without keeping it here.
           */
          "idempotency-key": idempotencyKey,
        },
        // The endpoint refuses an unexpected body, and takes none: the amount
        // is fixed by FR-10.1 and the account comes from the token.
        body: {},
      }),
      /*
       * Both, and this is why the two features share one cache. A top-up
       * changes the balance and writes a row into the history; invalidating
       * only the first leaves a screen showing new money above a list that
       * does not mention it.
       */
      invalidatesTags: ["Accounts", "History"],
    }),
  }),
})

export const { useAccountsQuery, useTopUpMutation } = accountsApi
