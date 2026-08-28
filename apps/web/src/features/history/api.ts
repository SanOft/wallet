import { type HistoryResponse, historyResponseSchema } from "@wallet/shared"
import { walletApi } from "../../app/api.js"
import { parseResponse } from "../../lib/parseResponse.js"

/** How many rows §13.3 puts on the home screen. */
export const RECENT_COUNT = 5

/**
 * FR-5, as the home screen needs it: the newest few, nothing else.
 *
 * The `limit` exists for this call. Asking for twenty rows to render five is
 * fifteen rows of somebody's mobile data, on the connection NFR-3 is written
 * for; the full page belongs to F5.
 */
export const historyApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    recentTransfers: build.query<HistoryResponse, void>({
      query: () => ({ url: "/transfers", params: { limit: RECENT_COUNT } }),
      transformResponse: parseResponse(historyResponseSchema),
      providesTags: ["History"],
    }),
  }),
})

export const { useRecentTransfersQuery } = historyApi
