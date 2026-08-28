import type { CookieOptions, Response } from "express"
import type { Env } from "../../config/env.js"

/** FR-2.4: the refresh token travels only here, never in a response body. */
export const REFRESH_COOKIE = "wallet_refresh"

/**
 * A hint, readable by JavaScript, that a refresh cookie exists.
 *
 * The refresh cookie is `httpOnly` on purpose, so the client cannot tell a
 * signed-out visitor from a signed-in one without asking — and it asked, on
 * every cold start, by calling `/api/auth/refresh` and receiving a `401` for
 * everyone who was not signed in. That is a guaranteed-to-fail request on the
 * first paint of the login screen: a round trip spent on a connection NFR-3
 * assumes is bad, and a browser console error on every anonymous page load.
 *
 * This carries no authority whatsoever. Its value is the string "1"; the
 * server never reads it and must never trust it. It answers exactly one
 * question, on the client, before any request: *is it worth asking?*
 *
 * Set and cleared in lockstep with the refresh cookie and with the same
 * lifetime, because the failure that matters is the two disagreeing. If the
 * hint outlives the refresh cookie the client makes one pointless call and
 * falls back to anonymous — today's behaviour. If it were to die first, a
 * signed-in user would meet the login screen, which is why the attributes are
 * derived from the same function rather than written twice.
 */
export const SESSION_HINT_COOKIE = "wallet_session"

/** FR-2.4: thirty days, in milliseconds. */
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Reads one cookie by name.
 *
 * Hand-written rather than pulling in `cookie-parser`, which is a judgement
 * call worth stating: the only cookie this service reads holds a base64url
 * value of our own making, so none of the escaping and quoting edge cases that
 * justify the dependency can arise. If a second cookie ever carries
 * user-supplied text, use the library instead of extending this.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined

  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue

    const raw = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      // A malformed percent-escape is not our value; treat it as absent.
      return undefined
    }
  }

  return undefined
}

/**
 * FR-2.4: `httpOnly; Secure; SameSite=Strict`.
 *
 * `httpOnly` keeps the token away from JavaScript, so an XSS that steals the
 * access token from memory still cannot mint new ones. `SameSite=Strict` is
 * what makes the cookie-bearing refresh endpoint safe from CSRF (§17.1) —
 * refresh only rotates tokens, it never moves money, but a forged refresh
 * would still be a session-fixation lever.
 *
 * `secure` is off in development because there is no TLS on localhost and the
 * browser would silently drop the cookie.
 */
function refreshCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: "/api/auth",
    ...(env.REFRESH_COOKIE_DOMAIN ? { domain: env.REFRESH_COOKIE_DOMAIN } : {}),
  }
}

/**
 * The hint's attributes, from the refresh cookie's, with two differences.
 *
 * `httpOnly: false` is the entire point — a hint no script can read hints at
 * nothing. `path: "/"` because the refresh cookie is scoped to `/api/auth`,
 * and a cookie the application cannot read on its own pages is equally
 * useless.
 */
function sessionHintOptions(env: Env): CookieOptions {
  return { ...refreshCookieOptions(env), httpOnly: false, path: "/" }
}

export function setRefreshCookie(res: Response, env: Env, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(env))
  // Never the token, and never anything derived from it: a value that is safe
  // to read is a value that says nothing.
  res.cookie(SESSION_HINT_COOKIE, "1", sessionHintOptions(env))
}

export function clearRefreshCookie(res: Response, env: Env): void {
  // Must match the attributes it was set with, or the browser keeps the
  // original and a "logged out" user is still holding a live token.
  const { maxAge: _maxAge, ...options } = refreshCookieOptions(env)
  res.clearCookie(REFRESH_COOKIE, options)

  // Cleared together, always. A hint left behind after logout sends the next
  // visit to a refresh call that cannot succeed — the exact request this
  // cookie exists to avoid.
  const { maxAge: _hintMaxAge, ...hintOptions } = sessionHintOptions(env)
  res.clearCookie(SESSION_HINT_COOKIE, hintOptions)
}
