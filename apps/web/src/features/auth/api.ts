import { createApi } from "@reduxjs/toolkit/query/react"
import type { AuthResponse, LoginRequest, PublicUser, RegisterRequest } from "@wallet/shared"
import { baseQueryWithReauth } from "../../app/baseQuery.js"
import { reportUnexpected } from "../../lib/report.js"
import { credentialsReceived, signedOut } from "./authSlice.js"

/**
 * The auth endpoints, typed by the contract rather than by hand.
 *
 * Every request and response type here comes from `packages/shared`, which is
 * the same module the server validates with (§8.2). A field renamed on one side
 * is a type error on the other, rather than a runtime surprise in a form.
 */
export const authApi = createApi({
  reducerPath: "authApi",
  baseQuery: baseQueryWithReauth,
  tagTypes: ["Me"],
  endpoints: (build) => ({
    register: build.mutation<AuthResponse, RegisterRequest>({
      query: (body) => ({ url: "/auth/register", method: "POST", body }),
      onQueryStarted: async (_arg, { dispatch, queryFulfilled }) => {
        // Caught, not left to float. `queryFulfilled` rejects on any failure —
        // a wrong password is the ordinary case — and an uncaught rejection
        // here reaches the browser console as an unhandled error for something
        // the UI is already reporting properly. The caller still sees the
        // failure through the mutation result.
        try {
          const { data } = await queryFulfilled
          dispatch(credentialsReceived({ accessToken: data.accessToken, user: data.user }))
        } catch (error) {
          // The form renders what it knows how to explain. Anything else — a
          // 500, an error shape nobody planned for — would otherwise vanish
          // between here and the generic sentence the user sees.
          reportUnexpected("auth:register", error, ["VALIDATION_ERROR", "REGISTRATION_FAILED"])
        }
      },
    }),

    login: build.mutation<AuthResponse, LoginRequest>({
      query: (body) => ({ url: "/auth/login", method: "POST", body }),
      /**
       * §12.3 pairs `AUTH_LOCKED` with a `Retry-After` header, and the screen
       * renders "try again in X" from it. Headers are not on the mutation
       * result, so the number is lifted here — the one hook RTK Query gives
       * that can still see the response.
       *
       * A missing or unparsable header becomes `undefined` rather than 0: zero
       * would render as "try again in 0 seconds", which invites the retry the
       * backoff exists to prevent.
       */
      transformErrorResponse: (error, meta) => {
        const header = meta?.response?.headers.get("retry-after")
        const seconds = header === null || header === undefined ? Number.NaN : Number(header)
        return Number.isFinite(seconds) && seconds > 0
          ? { ...error, retryAfterSeconds: seconds }
          : error
      },
      onQueryStarted: async (_arg, { dispatch, queryFulfilled }) => {
        // Caught, not left to float. `queryFulfilled` rejects on any failure —
        // a wrong password is the ordinary case — and an uncaught rejection
        // here reaches the browser console as an unhandled error for something
        // the UI is already reporting properly. The caller still sees the
        // failure through the mutation result.
        try {
          const { data } = await queryFulfilled
          dispatch(credentialsReceived({ accessToken: data.accessToken, user: data.user }))
        } catch (error) {
          // A wrong password and a lockout are the ordinary paths through this
          // form and are not reported: a console full of expected failures is
          // a console nobody reads.
          reportUnexpected("auth:login", error, [
            "AUTH_INVALID_CREDENTIALS",
            "AUTH_LOCKED",
            "VALIDATION_ERROR",
          ])
        }
      },
    }),

    /**
     * Called once on boot, not by a screen.
     *
     * The access token lives in memory (FR-2.4), so a reload has none — but the
     * refresh cookie survives. Without this the app would show the login screen
     * to someone who is still signed in, every time they refresh the page.
     */
    refresh: build.mutation<AuthResponse, void>({
      query: () => ({ url: "/auth/refresh", method: "POST" }),
    }),

    logout: build.mutation<void, void>({
      query: () => ({ url: "/auth/logout", method: "POST" }),
      onQueryStarted: async (_arg, { dispatch, queryFulfilled }) => {
        // Cleared whatever the server said. A logout that leaves the client
        // holding a token because the request failed is the wrong direction to
        // fail in.
        try {
          await queryFulfilled
        } finally {
          dispatch(signedOut())
        }
      },
    }),

    me: build.query<PublicUser, void>({
      query: () => ({ url: "/me" }),
      providesTags: ["Me"],
    }),
  }),
})

export const {
  useRegisterMutation,
  useLoginMutation,
  useRefreshMutation,
  useLogoutMutation,
  useMeQuery,
} = authApi
