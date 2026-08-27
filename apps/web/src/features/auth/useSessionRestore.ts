import type { AuthResponse } from "@wallet/shared"
import { useEffect } from "react"
import { useAppDispatch, useAppSelector } from "../../app/hooks.js"
import { authApi } from "./api.js"
import { credentialsReceived, signedOut } from "./authSlice.js"

/**
 * Turns `status: "unknown"` into an answer, once, on boot.
 *
 * The access token lives in memory (FR-2.4), so a reload has none — but the
 * refresh cookie survives, and it is the only thing that can say whether anyone
 * is still signed in. Without this the app shows the login screen to a
 * signed-in user on every page load: the same harm as logging them out, and
 * harder to notice, because it looks like the session simply expired.
 *
 * `status` starts as `"unknown"` rather than `"anonymous"` so a screen can tell
 * "nobody is signed in" from "we have not asked yet".
 */

/**
 * One refresh per page load, whatever React does with the effect.
 *
 * The status check alone is not enough: it only changes once the request
 * answers, so anything mounting this twice before then — Strict Mode in
 * development, a remount, a future Suspense retry — fires two refreshes. That
 * was observed in a browser (two `POST /auth/refresh` on one load) while all
 * 114 unit tests passed.
 *
 * It is worse than a duplicate request. Refresh *rotates* the token (FR-2.6),
 * so the second call presents one the first has already spent, the server reads
 * that as reuse, and §11.3's theft detection revokes the whole family — the app
 * signs itself out. `baseQueryWithReauth` holds this property for refreshes
 * triggered by a 401; boot does not pass through that path, so it needs its own.
 */
let bootRefresh: Promise<AuthResponse> | null = null

/** Test seam: module state outlives a test file otherwise. */
export function resetSessionRestore(): void {
  bootRefresh = null
}

export function useSessionRestore(): void {
  const dispatch = useAppDispatch()
  const status = useAppSelector((state) => state.auth.status)

  useEffect(() => {
    if (status !== "unknown") return

    let cancelled = false
    // Assigned before anything is awaited, so a second synchronous mount finds
    // it already set and joins rather than starting another.
    bootRefresh ??= dispatch(authApi.endpoints.refresh.initiate()).unwrap()

    void bootRefresh
      .then((data) => {
        if (cancelled) return
        dispatch(credentialsReceived({ accessToken: data.accessToken, user: data.user }))
      })
      .catch(() => {
        // No cookie, an expired one, or reuse already detected. All three mean
        // the same thing to the client, and none is an error worth showing:
        // not being signed in is a normal way to arrive.
        if (!cancelled) dispatch(signedOut())
      })

    return () => {
      cancelled = true
    }
  }, [dispatch, status])
}
