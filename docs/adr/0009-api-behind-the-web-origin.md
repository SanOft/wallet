# ADR-0009 — The API is served through the web origin, not beside it

**Status:** Accepted — day 6
**Closes:** P-14
**Relates to:** FR-2.4, §17.1, §20.1, `apps/web/vercel.json`

## Context

FR-2.4 puts the refresh token in a cookie marked `httpOnly; Secure;
SameSite=Strict`. §20.1 puts the PWA on Vercel and the API on Render.

Those two statements cannot both hold. `vercel.app` and `onrender.com` are
separate registrable domains and both appear on the Public Suffix List, so no
value of `REFRESH_COOKIE_DOMAIN` can span them, and a browser will not attach a
`SameSite=Strict` cookie to a request aimed at a different site.

The failure is invisible in development and in the test suite. Supertest issues
requests against one host, so cookies attach; local development runs both
services on `localhost`, so cookies attach. It breaks the first time a real
browser talks to the real deployment, and the symptom is not an error — every
session simply stops renewing after fifteen minutes and the user is logged out
with no explanation.

## Decision

Serve the API through the web origin, using a Vercel rewrite to an external
destination:

```json
{ "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" }
```

The browser's URL does not change, so `https://wallet.example.com/api/transfers`
is a **same-origin** request. The refresh cookie attaches, `SameSite=Strict`
keeps its full CSRF value, and FR-2.4 needs no amendment.

Two consequences are handled explicitly.

**The CDN must not store anything.** Vercel honours upstream `cache-control` on
external rewrites by default for projects created on or after 6 April 2026.
Every response here is specific to one caller — a balance, a transfer, a token —
and a cached `GET /api/accounts` is one user's balance served to another. Two
independent stops: `vercel.json` sets `x-vercel-enable-rewrite-caching: 0`, and
the API sends `Cache-Control: no-store` on every response. Either alone is
sufficient; the failure is bad enough to be worth both.

**The proxy chain grew a hop.** Requests now reach the API through Vercel *and*
the platform load balancer, and `app.set("trust proxy", 1)` encodes a hop count.
Whether 1 is still the right number is **not settled by this record** — it
depends on how each proxy populates `X-Forwarded-For`, which is a claim about
two vendors' runtime behaviour and has to be measured against the real
deployment, not reasoned about. Every rate limit keys on `req.ip` (P-11), so
getting it wrong buckets every caller together or trusts a forged header. The
production smoke test (T-6.3) is where this gets checked, and P-11 stays open
until it does.

## Consequences

`SameSite=Strict` survives, which means no CSRF token, no double-submit cookie,
and no second credential for the client to manage. The strongest option is also
the one with the least machinery.

CORS stops being load-bearing for the PWA — same-origin requests do not consult
it. The allowlist stays for non-browser callers and as defence in depth, but the
browser path no longer depends on it, which removes a class of deploy-time
misconfiguration.

Costs:

- One more hop of latency on every API call, and one more component that can be
  down. Vercel's edge is closer to the user than the API's single region, so the
  practical effect is smaller than it sounds — but the API is no longer
  reachable at its own name from the PWA's perspective.
- The rewrite destination is a hostname in a committed file, and Vercel does not
  interpolate environment variables there, so it cannot be supplied at deploy
  time. A wrong value is not a broken deploy — it is a **silent misroute**, and
  every `*.onrender.com` name resolves whether or not anyone owns it, so a
  plausible guess could send login requests to a stranger who claims that
  subdomain later. The committed placeholder is therefore
  `https://set-me-at-t-6-1.invalid/...`: `.invalid` is reserved by RFC 2606 and
  can never resolve or be registered, so the deployment fails loudly and
  unmistakably until T-6.1 replaces it with the real host.
- Streaming responses pass through a proxy that may buffer. This matters if
  ADR-0007's SSE stream lands, and should be verified then rather than assumed.
- Vercel is now in the request path for money operations. That is a real
  availability coupling and the honest reason to revisit this if the deployment
  ever leaves the free tier.

## Alternatives rejected

**`SameSite=Lax` plus an explicit CSRF token.** Keeps the two services on their
own origins. Rejected because it trades a property the browser enforces for one
the application must implement correctly on every state-changing route — and
because `Lax` still would not attach the cookie to a cross-site `fetch`, so the
refresh call needs `SameSite=None`, which is the weakest setting of the three
and puts the whole burden on the CSRF token.

**A shared parent domain — `app.wallet.uz` and `api.wallet.uz`.** Genuinely the
cleanest answer, and the one to take when a custom domain exists: both are the
same site, so `SameSite=Strict` works with no proxy at all. Rejected *for now*
only because it requires a registered domain, which the project does not have.
**This ADR should be revisited the day one is bought.**

**Move the API onto Vercel functions.** Removes the second platform entirely.
Rejected: the ledger needs long-lived connection pooling and interactive
transactions, which fit a persistent process rather than a function invocation.

## Reversibility

**Easy.** The rewrite is four lines of JSON and the cookie attributes are one
function. Moving to a shared parent domain later means deleting the rewrite and
setting `REFRESH_COOKIE_DOMAIN` — no code change and no contract change, because
the client always spoke to `/api` on its own origin either way. That property is
the reason to prefer this over the CSRF route even before the domain exists.
