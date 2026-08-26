# ADR-0007 — Server-sent events for live balance

**Status:** Proposed — deferred to September (runbook §4)
**Relates to:** spec §13.4, FR-3.4, FR-4.8, §20.3

## Context

When money arrives, the recipient's balance should change without them pulling
to refresh. The three ways to do that are polling, server-sent events, and
WebSockets.

The traffic is one-directional and rare: the server has something to say a few
times a day per user, and the client has nothing to say back over the same
channel — it already has a REST API for that.

The deployment constrains the choice. §20.3 records that the free Render tier
sleeps after inactivity and cold-starts on the next request, so any long-lived
connection is going to be dropped routinely rather than exceptionally.
Reconnection is the normal case, not the error case.

## Decision

Server-sent events, on a single authenticated `GET /api/events` stream, carrying
balance updates and transfer status transitions.

- SSE is plain HTTP. It passes proxies and corporate networks that break
  WebSocket upgrades, and it needs no second protocol on the server.
- `EventSource` reconnects automatically with backoff, and resumes with a
  `Last-Event-ID` header. Given a platform that sleeps, getting reconnection
  from the browser rather than writing it is most of the value.
- Events carry the transfer id and the new balance. The client treats them as
  invalidation hints rather than as truth: it invalidates the RTK Query tag and
  refetches. An event that arrives twice, or out of order, therefore costs one
  redundant request and cannot corrupt what is displayed.

## Consequences

The live-balance feature costs one endpoint and no new infrastructure. The
"treat events as hints" rule means the stream is allowed to be unreliable, which
is the only honest assumption on a tier that sleeps.

Costs:

- One held connection per open tab, and Render's free tier is one instance
  (§20.3). Broadcasting across instances would need a shared bus, which is the
  same problem the rate limiter has in P-22.
- `EventSource` cannot set an `Authorization` header. Either the token goes in
  the query string — where it lands in access logs, which the logger's
  serialiser already strips for exactly this reason — or the stream authenticates
  from the refresh cookie, which reopens the cross-site cookie problem in P-14.
  **This is the open question and it must be settled before implementation.**
- Six-connection-per-origin limit under HTTP/1.1. Irrelevant over HTTP/2, which
  Render terminates.

## Alternatives rejected

**Polling every 30 seconds.** Simplest, survives sleeping instances trivially,
and no connection state. Rejected on cost rather than capability: it is
continuous traffic against a database on a free tier, for an event that happens
a few times a day. It remains the correct fallback when the stream is
unavailable, and the client should implement it as such.

**WebSockets.** Bidirectional, which this does not need, and it brings a second
protocol, its own auth handshake, its own proxy failures and its own
reconnection logic to write.

**Web Push.** Solves a different problem — notifying a user whose app is
closed, which FR-4.10 may want later — and does not update an open screen.

## Reversibility

**Easy.** The client already refetches through RTK Query tags, so the stream is
an optimisation on top of a working pull model. Deleting it leaves a product
that refreshes on navigation and on demand. That property should be preserved
deliberately: the stream must never become the only path by which the balance
updates.
