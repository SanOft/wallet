import { createApi } from "@reduxjs/toolkit/query/react"
import { baseQueryWithReauth } from "./baseQuery.js"

/**
 * One cache for everything that is not authentication.
 *
 * Separate `createApi` slices do not share a cache, and the invalidation this
 * screen needs crosses features: a demo top-up changes the balance *and* adds
 * a row to the history. With two slices that link has to be maintained by hand
 * — one of them refetches and the other quietly shows the previous world, on
 * the same screen, at the same time. A user reading "1 000 000" above a list
 * that does not mention where it came from has been told two different things.
 *
 * Features still own their endpoints: each injects into this slice from its own
 * folder, so the file layout follows the domain while the cache follows the
 * data.
 *
 * `authApi` stays separate. Its endpoints are the ones the refresh mutex must
 * never re-authenticate (`baseQuery.ts`), and keeping that boundary visible in
 * the module graph is worth one extra reducer.
 */
export const walletApi = createApi({
  reducerPath: "walletApi",
  baseQuery: baseQueryWithReauth,
  tagTypes: ["Accounts", "History", "Rates"],
  /*
   * `setupListeners` in `store.ts` only *dispatches* online/offline; a query
   * refetches on reconnect solely because it opted in here, and the default is
   * off. That gap was live until F3's tests caught it: the store's comment
   * claimed reconnect handling and nothing did it, so a phone coming back from
   * a tunnel kept showing the balance from before the tunnel, indefinitely and
   * silently.
   *
   * `refetchOnFocus` stays off. A wallet that reloads every time the user
   * switches apps spends their data to show them the same number, and the
   * freshness line already tells them how old it is.
   */
  refetchOnReconnect: true,
  /**
   * Empty on purpose — `injectEndpoints` fills it. Listing endpoints here
   * instead would make this file import every feature, which is the import
   * cycle that ends with one module knowing the whole application.
   */
  endpoints: () => ({}),
})
