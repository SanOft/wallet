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

/**
 * The name of the readable companion to the `httpOnly` refresh cookie.
 *
 * Duplicated from `apps/api/src/adapters/http/cookies.ts` rather than shared
 * through `packages/shared`, and that is a deliberate limit: the client is not
 * allowed to know anything about this cookie except that it exists. Putting it
 * in the contract package would invite a second use, and the second use of a
 * cookie the server never verifies is where it stops being a hint and starts
 * being an authorisation nobody meant to grant.
 */
const SESSION_HINT = "wallet_session"

function hasSessionHint(): boolean {
  // `document.cookie` is a flat string; the hint holds "1" and nothing else,
  // so presence of the name is the entire question.
  return document.cookie.split(";").some((part) => part.trim().startsWith(`${SESSION_HINT}=`))
}

export function useSessionRestore(): void {
  const dispatch = useAppDispatch()
  const status = useAppSelector((state) => state.auth.status)

  useEffect(() => {
    if (status !== "unknown") return

    /*
     * Do not ask when the answer is already known to be no.
     *
     * The refresh cookie cannot be read from JavaScript, so this used to call
     * `/api/auth/refresh` on every cold start and take a `401` for everyone
     * who was not signed in — a request guaranteed to fail, on the first paint
     * of the login screen, spending a round trip on a connection NFR-3 assumes
     * is bad. It also put a console error on every anonymous page load, which
     * is what Lighthouse's best-practices audit was reporting.
     *
     * The hint is set beside the refresh cookie and cleared with it. If it is
     * ever wrong in the direction of absent-but-signed-in, this shows the
     * login screen to someone who is still authenticated — which is why the
     * server derives both cookies' attributes from one function.
     */
    if (!hasSessionHint()) {
      dispatch(signedOut())
      return
    }

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
