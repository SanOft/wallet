import type { UssdCallback } from "@wallet/shared"
import { walletApi } from "../../app/api.js"
import { parseReply, type Reply } from "./session.js"

/**
 * FR-9.6's door, and the only endpoint in this application that does not
 * speak JSON.
 *
 * A USSD reply is plain text prefixed `CON ` or `END ` (FR-9.3). That is not a
 * simplification of a JSON body, it is the protocol — so this endpoint sets
 * `responseHandler: "text"` and parses the prefix itself. `parseResponse` and
 * the Zod contract every other endpoint goes through have nothing to check
 * here; there is no schema for a string whose meaning is its first four
 * characters.
 */

/**
 * What the simulator sends. `phoneNumber` is in the type because the wire
 * carries it, and is set to the caller's own number for display only — the
 * server overwrites it from the session before parsing, so whatever is sent
 * here reaches nothing. Sending it anyway keeps the request the shape a real
 * gateway posts, which is the claim FR-9.6 makes.
 */
export type DialArgs = UssdCallback

export const ussdApi = walletApi.injectEndpoints({
  endpoints: (build) => ({
    dial: build.mutation<Reply, DialArgs>({
      query: (body) => ({
        url: "/channels/ussd/simulate",
        method: "POST",
        body,
        /*
         * Without this, `fetchBaseQuery` runs `response.json()` over
         * `CON Wallet\n1. Balans` and every dial fails as a parse error —
         * which would look exactly like the server being down.
         */
        responseHandler: "text",
      }),

      /*
       * A malformed body becomes a *value*, not a thrown error.
       *
       * The two failures need different words on screen and must never be
       * confused: "the gateway could not be reached" is a transport problem
       * the user can retry, and "the server answered something that is not a
       * USSD reply" is a protocol fault they cannot. Throwing here would merge
       * them into one red box.
       */
      transformResponse: (body: unknown): Reply => parseReply(String(body)),

      /*
       * A USSD transfer moves real money through the same TransferService the
       * web wizard uses, so the balance and the history on the other screens
       * are stale the moment one completes. Invalidated unconditionally: this
       * endpoint cannot tell a balance enquiry from a transfer without parsing
       * the menu, and re-reading two cached queries costs less than showing
       * somebody a balance that has already changed.
       */
      invalidatesTags: ["Accounts", "History"],
    }),
  }),
})

export const { useDialMutation } = ussdApi
