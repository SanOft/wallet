import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import type { PublicUser } from "@wallet/shared"

/**
 * The access token, and nowhere else.
 *
 * FR-2.4 puts it in client memory only. Not `localStorage`, not
 * `sessionStorage`, not a non-httpOnly cookie: any of those is readable by
 * script, which turns one XSS into a session that outlives the tab. Memory is
 * lost on reload, and that is the trade — the refresh cookie, which script
 * cannot read, is what restores it.
 *
 * `status` exists because "no token" means two different things on boot. Before
 * the silent refresh has answered, the app does not yet know whether anyone is
 * signed in; showing the login screen in that gap logs people out on every
 * reload.
 */

export type AuthStatus = "unknown" | "authenticated" | "anonymous"

export interface AuthState {
  readonly accessToken: string | null
  readonly user: PublicUser | null
  readonly status: AuthStatus
}

const initialState: AuthState = {
  accessToken: null,
  user: null,
  status: "unknown",
}

export const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    credentialsReceived(
      state,
      action: PayloadAction<{ accessToken: string; user?: PublicUser | undefined }>,
    ) {
      state.accessToken = action.payload.accessToken
      state.status = "authenticated"
      if (action.payload.user) state.user = action.payload.user
    },

    /**
     * Everything forgotten, including the user.
     *
     * Reached from three places that are worth distinguishing in the UI but
     * not here: an explicit sign-out, a refresh that returned 401, and reuse
     * detection. In every case the client's job is the same — hold nothing.
     */
    signedOut(state) {
      state.accessToken = null
      state.user = null
      state.status = "anonymous"
    },
  },
})

export const { credentialsReceived, signedOut } = authSlice.actions
