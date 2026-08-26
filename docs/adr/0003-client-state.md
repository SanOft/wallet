# ADR-0003 — Redux Toolkit + RTK Query for client state

**Status:** Proposed — the frontend begins in September (F0–F7)
**Relates to:** spec §8.4, §13.5, FR-8.3, FR-8.4

## Context

The PWA has two kinds of state and they are usually conflated.

**Server state**: balances, transaction history, exchange rates. Owned by the
API, cached on the client, stale the moment it arrives. FR-3.4 requires the UI
to display how old a cached balance is — so staleness is not an implementation
detail here, it is a rendered product feature.

**Client state**: the four-step transfer wizard, and the offline outbox. The
outbox is the demanding one: FR-8.3 requires a transfer composed offline to be
queued durably and replayed when connectivity returns, and FR-8.4 requires
replay to be idempotent and to retry `5xx` while never retrying `4xx`. That is a
persistent queue with a retry policy, living in the client.

The wizard is the opposite: §13.5 requires it to be **lost** on reload, on the
grounds that resuming a half-finished money operation is more dangerous than
making the user start again.

## Decision

Redux Toolkit for client state, RTK Query for server state, in one store.

- RTK Query owns caching, request deduplication, tag-based invalidation and the
  `stale` metadata the balance-age indicator reads. A completed transfer
  invalidates the balance and history tags, so the screens refresh without a
  hand-written refetch.
- A `transferSlice` holds wizard state, deliberately not persisted.
- An `outboxSlice` holds the queue, persisted to IndexedDB, with the retry
  policy expressed against the shared error catalogue — `isRetryable()` in
  `packages/shared` already decides `5xx` versus `4xx`, so client and server
  agree by construction rather than by comment.
- `baseQueryWithReauth` wraps the base query so a `401` triggers one silent
  refresh and replays the request, which is what D-2 in §13.9 specifies.

## Consequences

The outbox is the reason for the choice. A visible, serialisable, inspectable
state tree is worth a great deal when the bug being diagnosed is "a transfer
composed on the metro was never sent" — the queue can be dumped, replayed and
tested without a browser.

Costs:

- Boilerplate, even with RTK's helpers. For a nine-endpoint API this is real
  overhead relative to the alternatives.
- RTK Query is a smaller ecosystem than TanStack Query and its documentation is
  thinner for unusual cases.
- One store means one place for a careless `persist` to serialise the wizard
  state that §13.5 requires to be volatile. The slice must opt out explicitly.

## Alternatives rejected

**TanStack Query + Zustand.** Better ergonomics for server state and a much
smaller client-state layer. Rejected narrowly: it splits the outbox across two
libraries, and the outbox is the part of this frontend most likely to be wrong.

**TanStack Query alone, outbox in IndexedDB by hand.** The least code for the
common path, and the retry policy becomes bespoke, untyped and untested.

**Context + `useReducer`.** No dependency. Rejected: a durable retry queue is
not a `useReducer` problem, and building one there means rebuilding middleware.

## Reversibility

**Moderate, and it decreases quickly.** While only the API-facing hooks exist,
swapping the data layer is mechanical. Once wizard, outbox and reauth are built
on the store's middleware, the coupling is real. This ADR should be revisited
at F1, before the outbox is written — not after.
