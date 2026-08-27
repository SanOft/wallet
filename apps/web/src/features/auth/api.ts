import { createApi } from "@reduxjs/toolkit/query/react"
import type { AuthResponse, LoginRequest, PublicUser, RegisterRequest } from "@wallet/shared"
import { baseQueryWithReauth } from "../../app/baseQuery.js"
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
        const { data } = await queryFulfilled
        dispatch(credentialsReceived({ accessToken: data.accessToken, user: data.user }))
      },
    }),

    login: build.mutation<AuthResponse, LoginRequest>({
      query: (body) => ({ url: "/auth/login", method: "POST", body }),
      onQueryStarted: async (_arg, { dispatch, queryFulfilled }) => {
        const { data } = await queryFulfilled
        dispatch(credentialsReceived({ accessToken: data.accessToken, user: data.user }))
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
