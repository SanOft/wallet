import { isIP } from "node:net"
import cors from "cors"
import type { Request, RequestHandler, Response } from "express"
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
 * `Cache-Control: no-store` on everything this service returns.
 *
 * Nothing here is cacheable: a balance, a transfer and a token are all specific
 * to one caller at one moment. The header is not a micro-optimisation in
 * reverse — it is the control that stops a shared cache from serving one user's
 * balance to another.
 *
 * It matters more since the deploy topology put a CDN in front (ADR-0009).
 * Vercel honours upstream cache headers on external rewrites by default for
 * projects created on or after 6 April 2026, so "the API sends no cache header"
 * stopped being a safe default the moment the proxy existed. `vercel.json`
 * disables that caching too; either alone is sufficient, which is the point —
 * the failure mode is bad enough to be worth two independent stops.
 */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store")
    next()
  }
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
  /** Only failures count. See `loginRateLimit`. */
  readonly skipSuccessful?: boolean
  /** Meter something other than the address. See `ussdGatewayRateLimit`. */
  readonly keyGenerator?: (req: Request) => string
  /** Answer in something other than the §12.3 envelope. Same reason. */
  readonly refuse?: (res: Response) => void
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    ...(options.skipSuccessful ? { skipSuccessfulRequests: true } : {}),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: options.keyGenerator ?? clientKey,
    ...(options.skipPreflight ? { skip: (req: Request) => req.method === "OPTIONS" } : {}),
    // Routed through the error handler so a throttled caller gets the §12.3
    // envelope like every other failure, rather than express-rate-limit's own
    // plain-text body.
    handler: (_req, res, next) => {
      if (options.refuse) {
        options.refuse(res)
        return
      }
      next(new DomainError("RATE_LIMITED", options.message))
    },
  })
}

/** The path a real gateway posts to, exempt from the address-keyed budget. */
export const USSD_GATEWAY_PATH = "/api/channels/ussd"

/**
 * The gateway callback, metered per subscriber rather than per address (P-33).
 *
 * A carrier gateway is one address serving a whole network. Under the global
 * 300-per-quarter-hour budget a four-step session is four requests, so roughly
 * seventy-five sessions would exhaust the allowance for *everybody* behind that
 * gateway — an outage with a security rationale attached, and the people it
 * stops are the customers.
 *
 * Worse than the throttling is how it was answered. `sendReply` returns 200
 * even for a refusal, deliberately: a gateway reads a non-2xx as a failed
 * session and shows the subscriber its own error instead of ours. The global
 * limiter answers `429` carrying the §12.3 JSON envelope — a status the
 * protocol treats as broken, with a body written for a developer, rendered on
 * a handset. Hence `refuse`: a refusal here ends the session in the language
 * the channel speaks.
 *
 * Keyed on the number in the callback. One without a number falls back to the
 * address, so a malformed body cannot buy an unmetered budget — that fallback
 * is why the key is a function rather than a field.
 */
export function ussdGatewayRateLimit(refuse: (res: Response) => void): RequestHandler {
  return limiter({
    windowMs: 15 * 60 * 1000,
    // Ten four-step sessions a quarter hour for one subscriber: generous for
    // somebody checking a balance, and still a bound.
    max: 40,
    message: "Too many requests",
    keyGenerator: (req) => {
      const phone = (req.body as { phoneNumber?: unknown } | undefined)?.phoneNumber
      return typeof phone === "string" && phone.length > 0 ? `ussd:${phone}` : clientKey(req)
    },
    refuse,
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
 * Registration: a cap on how fast identities can be minted.
 *
 * Registration being unthrottled is what made FR-4.9's lookup cap decorative:
 * identities cost about 54 ms each, so an enumerator could mint tens of
 * thousands an hour and buy twenty lookups with every one. Capping account
 * creation is what gives the per-user counter something scarce to count
 * (P-20).
 *
 * Every request counts here, successes included, which is the difference from
 * `loginRateLimit` below. A *successful* registration is the thing being
 * limited; skipping it would remove the control entirely.
 */
export function registerRateLimit(): RequestHandler {
  return limiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many authentication attempts",
    // A browser sends a preflight before every cross-origin JSON POST, so
    // counting them would halve the real allowance. Preflights are not exempt
    // from metering — the global limiter counts them.
    skipPreflight: true,
  })
}

/**
 * Login: a cap on how fast passwords can be *guessed*, not on how often people
 * sign in (P-25).
 *
 * The problem this solves is a market fact rather than a security one. Uzbek
 * carriers put whole subscriber pools behind one address, so a per-IP budget of
 * twenty per quarter hour is not twenty attempts by one person — it is twenty
 * sign-ins for everybody on that NAT. That is an outage with a security
 * rationale attached, and the people it stops are the customers.
 *
 * `skipSuccessfulRequests` is what separates the two populations, and it works
 * because they differ in the one way that matters: **legitimate users mostly
 * succeed and attackers mostly fail.** A subscriber who signs in correctly
 * costs the shared address nothing at all, however many of them there are. A
 * caller working through a password list spends the budget at full speed.
 *
 * P-25 proposed keying the budget on the phone number as well as the address.
 * That is not done here, deliberately. Two reasons:
 *
 *   - The per-account dimension already exists. FR-2.3's backoff counts
 *     consecutive failures against a keyed digest of the number, in the
 *     database, and reaches a fifteen-minute delay quickly (P-15). Adding a
 *     second per-account counter would be the same rule in two places, which
 *     is what P-34 was about.
 *   - Keying on `(address, number)` would give a spray attacker a *fresh*
 *     budget for every account they try, which is precisely the attack the
 *     address budget exists to bound. It would read as a tightening and be a
 *     loosening.
 *
 * Fifty rather than twenty because these are now failures: on a shared address
 * some mistyped passwords are ordinary, and fifty in a quarter hour is not.
 * Together with the per-account backoff behind it, an attacker gets a bounded
 * number of guesses spread thinly, each account slowing down as it is touched.
 */
export function loginRateLimit(): RequestHandler {
  return limiter({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: "Too many authentication attempts",
    skipPreflight: true,
    /*
     * `< 400` is the library's definition of successful. A wrong password is
     * 401, a locked-out caller 429, a malformed body 400 — all counted. Only a
     * completed sign-in is free, which is the whole intent.
     */
    skipSuccessful: true,
  })
}
