import type { CookieOptions, Response } from "express"
import type { Env } from "../../config/env.js"

/** FR-2.4: the refresh token travels only here, never in a response body. */
export const REFRESH_COOKIE = "wallet_refresh"

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

export function setRefreshCookie(res: Response, env: Env, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(env))
}

export function clearRefreshCookie(res: Response, env: Env): void {
  // Must match the attributes it was set with, or the browser keeps the
  // original and a "logged out" user is still holding a live token.
  const { maxAge: _maxAge, ...options } = refreshCookieOptions(env)
  res.clearCookie(REFRESH_COOKIE, options)
}
