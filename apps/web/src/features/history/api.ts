import {
  HISTORY_PAGE_MAX,
  type HistoryItem,
  type HistoryResponse,
  historyItemSchema,
  historyResponseSchema,
} from "@wallet/shared"
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
/** The filters §13.5 keeps in the URL, as the query sends them. */
export interface HistoryFilters {
  readonly direction?: "incoming" | "outgoing"
  readonly status?: "PENDING" | "COMPLETED" | "FAILED"
  readonly from?: string
  readonly to?: string
  readonly cursor?: string
}

export const historyApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    recentTransfers: build.query<HistoryResponse, void>({
      query: () => ({ url: "/transfers", params: { limit: RECENT_COUNT } }),
      transformResponse: parseResponse(historyResponseSchema, "history"),
      providesTags: ["History"],
    }),
    /**
     * FR-5.1's page, with FR-5.2's filters.
     *
     * A separate endpoint from `recentTransfers` rather than one with an
     * argument, because they are cached differently: the home screen's five
     * rows are invalidated by every transfer, and this one is a list somebody
     * is scrolling — refetching page one underneath them because a top-up
     * completed would move the rows they are reading.
     */
    transferPage: build.query<HistoryResponse, HistoryFilters>({
      query: (filters) => ({
        url: "/transfers",
        params: { ...filters, limit: HISTORY_PAGE_MAX },
      }),
      transformResponse: parseResponse(historyResponseSchema, "history"),

      /*
       * Pages accumulate into one cache entry keyed by the filters, so
       * scrolling does not discard what is already on screen. The cursor is
       * deliberately excluded from the key — a new cursor is more of the same
       * list, not a different one.
       */
      serializeQueryArgs: ({ queryArgs }) => {
        const { cursor: _cursor, ...rest } = queryArgs
        return rest
      },
      merge: (existing, incoming, { arg }) => {
        // No cursor means the first page: a filter changed, and the previous
        // rows describe a different question.
        if (!arg.cursor) return incoming

        return {
          items: [...existing.items, ...incoming.items],
          nextCursor: incoming.nextCursor,
        }
      },
      forceRefetch: ({ currentArg, previousArg }) => currentArg?.cursor !== previousArg?.cursor,
      providesTags: ["History"],
    }),

    oneTransfer: build.query<HistoryItem, string>({
      query: (id) => `/transfers/${id}`,
      transformResponse: parseResponse(historyItemSchema, "transfer"),
      providesTags: ["History"],
    }),
  }),
})

export const { useRecentTransfersQuery, useTransferPageQuery, useOneTransferQuery } = historyApi
