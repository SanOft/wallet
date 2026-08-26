import { isIP } from "node:net"
import cors from "cors"
import type { Request, RequestHandler } from "express"
import { ipKeyGenerator, rateLimit } from "express-rate-limit"
import helmet from "helmet"
import type { Env } from "../../config/env.js"
import { DomainError } from "../../domain/errors.js"

/**
 * Transport hardening (§17.3, NFR-1.8).
 *
 * Everything here is a control the threat model names, wired in one place so
 * the checklist can be read against one file rather than hunted for.
 */

/**
 * helmet, with a CSP appropriate to an API rather than to a page.
 *
 * `default-src 'none'` is the right default here: this service returns JSON and
 * never a document, so there is nothing legitimate for a browser to load from
 * it. §17.1 lists CSP as the control for "token theft via XSS" — the access
 * token lives in memory (FR-2.4), so the relevant XSS is one served *from* this
 * origin, and a policy that permits nothing is the strongest form of that.
 *
 * HSTS is on with a year's max-age. Render terminates TLS in front of this
 * process, so the header is what tells the browser never to try plaintext
 * again — which matters for a refresh cookie marked `Secure`.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
    // The API is not a page and must never be framed.
    frameguard: { action: "deny" },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    // Referrer leakage is a non-issue for JSON, but the header costs nothing
    // and an error page could otherwise carry a path to a third party.
    referrerPolicy: { policy: "no-referrer" },
    // `x-powered-by` is already disabled on the app; helmet removes it too.
    crossOriginResourcePolicy: { policy: "same-site" },
  })
}

/**
 * CORS from the configured allowlist (NFR-1.8: "not `*`").
 *
 * `credentials: true` is required because the refresh cookie is the only
 * credential on `/api/auth/refresh` (FR-2.4), and a wildcard origin is
 * forbidden by the browser in that mode anyway — so the allowlist is not
 * merely policy here, it is the only thing that can work.
 *
 * A request with no `Origin` header is allowed through: that is a server-side
 * caller, a health probe, or curl, none of which the same-origin policy
 * governs. CORS protects browsers from other browsers' tabs; it is not an
 * authentication mechanism, and treating it as one is how people end up
 * believing an API is protected when it is not.
 */
export function corsPolicy(env: Env): RequestHandler {
  const allowed = new Set(env.CORS_ORIGINS)

  return cors({
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) {
        callback(null, true)
        return
      }
      // Refused by omitting the header rather than by erroring, which is what
      // the browser expects and what keeps the response inside §12.3.
      callback(null, false)
    },
    credentials: true,
    // Only the verbs routes actually implement. Advertising PUT and DELETE
    // described an API that does not exist.
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-request-id"],
    // A cross-origin caller can read only what is named here. Without the rate
    // limit headers the PWA cannot render §12.3's "try again in X minutes" —
    // the values are on the response and the browser hides them.
    exposedHeaders: ["x-request-id", "retry-after", "ratelimit", "ratelimit-policy"],
    maxAge: 600,
  })
}

/**
 * `Vary: Origin` on every response, not only the ones CORS decorated.
 *
 * A refused origin gets no `Access-Control-*` headers, and `cors` returns
 * before setting `Vary` — so the allowed and refused variants of the same URL
 * are byte-identical to a cache keyed on the URL alone, and it may serve the
 * header-less one to an allowlisted origin. Availability rather than
 * disclosure, but both variants have to declare what they vary on.
 */
export function varyOrigin(): RequestHandler {
  return (_req, res, next) => {
    res.vary("Origin")
    next()
  }
}

/**
 * Ends every preflight that `cors` did not.
 *
 * `cors` answers an allowed preflight itself. A refused one calls `next()` and
 * emits nothing, so the request used to fall through to Express 5's automatic
 * OPTIONS handler, which replies `200` with `Allow: POST` and the verb list as
 * a `text/plain` body. Unauthenticated, unthrottled, and outside §12.3 — and
 * because an unrouted path 404s instead, the pair is a clean route-existence
 * oracle for exactly the caller CORS just refused.
 *
 * Answering every remaining preflight identically removes the signal: 204, no
 * body, no `Allow`, no CORS headers. A caller learns only that the server
 * speaks HTTP.
 */
export function terminatePreflight(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "OPTIONS") {
      next()
      return
    }
    res.status(204).end()
  }
}

/**
 * The bucket a request counts against.
 *
 * `req.ip` is whatever the trusted hop reported, and off the load balancer that
 * is the caller (P-11). Forgery is one problem; a value that is not an address
 * at all is a worse one, because every distinct string becomes its own counter
 * and therefore its own full budget — thirty requests with thirty different
 * garbage headers were never throttled at all. Anything unparsable shares a
 * single bucket, so the same trick now costs one budget rather than minting
 * them.
 *
 * Real addresses go through `ipKeyGenerator`, which masks IPv6 to a subnet —
 * a single client controls far more than one v6 address.
 */
function clientKey(req: Request): string {
  const ip = req.ip
  if (!ip || isIP(ip) === 0) return "unparsable-client-address"
  return ipKeyGenerator(ip)
}

/**
 * Rate limits keyed on IP.
 *
 * Stated plainly: `req.ip` is only trustworthy behind the single proxy hop
 * `trust proxy` is set for. Off-Render — locally, or on any deployment
 * reachable without passing through the load balancer — a caller can forge it,
 * and these limits are then advisory. That is tracked as P-11.
 *
 * The store is in-process, so the limits are per-instance. Render's free tier
 * runs one (§20.3); more than one needs a shared store, which belongs with the
 * same move as the lookup counter.
 */
function limiter(options: {
  readonly windowMs: number
  readonly max: number
  readonly message: string
  readonly skipPreflight?: boolean
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: clientKey,
    ...(options.skipPreflight ? { skip: (req: Request) => req.method === "OPTIONS" } : {}),
    // Routed through the error handler so a throttled caller gets the §12.3
    // envelope like every other failure, rather than express-rate-limit's own
    // plain-text body.
    handler: (_req, _res, next) => {
      next(new DomainError("RATE_LIMITED", options.message))
    },
  })
}

/** Everything, as a backstop against a single caller saturating the process. */
export function globalRateLimit(): RequestHandler {
  return limiter({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: "Too many requests",
  })
}

/**
 * Registration and login, much tighter.
 *
 * Registration being unthrottled is what made FR-4.9's lookup cap
 * decorative: identities cost about 54 ms each, so an enumerator could mint
 * tens of thousands an hour and buy twenty lookups with every one. Capping
 * account creation is what gives the per-user counter something scarce to
 * count (P-20).
 *
 * It also mitigates the login bombardment §17.1 lists under denial of service,
 * which FR-2.3's per-account lockout would otherwise be alone in handling —
 * and that lockout is deferred to September (P-15).
 */
export function authRateLimit(): RequestHandler {
  return limiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many authentication attempts",
    // This budget bounds authentication *attempts*. A browser sends a preflight
    // before every cross-origin JSON POST, so counting them would halve the
    // real allowance to ten logins and make the number mean something other
    // than FR-2.3 says. Preflights are not exempt from metering — the global
    // limiter counts them.
    skipPreflight: true,
  })
}
