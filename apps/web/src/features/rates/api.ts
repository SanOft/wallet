import { type RatesResponse, ratesResponseSchema } from "@wallet/shared"
import { walletApi } from "../../app/api.js"
import { parseResponse } from "../../lib/parseResponse.js"

/**
 * FR-7. Informational only, and treated that way everywhere.
 *
 * The server already caches these for an hour and tells us, on every response,
 * whether the values it served are the last known ones rather than current
 * ones (`stale`). The widget renders that flag rather than deciding for itself
 * — the bank publishes once a day and the TTL is a server-side policy, so a
 * client that judged freshness from a timestamp would eventually disagree with
 * the server about the same numbers.
 */
export const ratesApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    rates: build.query<RatesResponse, void>({
      query: () => "/rates",
      transformResponse: parseResponse(ratesResponseSchema, "rates"),
      providesTags: ["Rates"],
    }),
  }),
})

export const { useRatesQuery } = ratesApi
