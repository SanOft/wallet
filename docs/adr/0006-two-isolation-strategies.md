# ADR-0006 — Serializable for transfers, an advisory lock for top-ups

**Status:** Accepted — day 5
**Relates to:** spec §10, I-5, FR-4.3, FR-10, `apps/api/src/domain/TransferService.ts`

## Context

Two operations move money, and they contend differently.

A **P2P transfer** reads the sender's balance, decides whether it is sufficient,
and writes. Two concurrent transfers from the same account are the classic lost
update: both read 1 000, both decide 700 is affordable, both write, and the
account ends at 300 having spent 1 400. Contention is per sender, and a sender
racing themselves is rare.

A **demo top-up** moves funds out of the single treasury account (FR-10). Every
top-up in the system contends with every other, on one row. Contention here is
not an edge case — it is the normal operating condition.

## Decision

Different mechanisms, chosen per operation rather than one policy applied to
both.

**P2P transfer: `Serializable`, with bounded retry.** Postgres detects the
conflict through SSI and aborts one transaction with `40001`, which Prisma
surfaces as `P2034`. The service retries up to three times (FR-4.3), pausing
between attempts with exponential backoff plus jitter — `2^attempt * 5ms *
(0.5 + random)`. Without the jitter, two retrying transactions re-collide in
step; a straight retry loop was measured rejecting 63% of a concurrent burst.

**Top-up: `pg_advisory_xact_lock` on the treasury, at `ReadCommitted`.** The
lock is taken **first**, then the treasury is read. That order is the whole
mechanism: under `ReadCommitted` each statement takes a fresh snapshot, so a
read that happens after the lock is granted sees every committed decrement.

The second half of that decision is subtle and was arrived at by measurement.
Keeping `Serializable` *and* adding the lock does not work: a `Serializable`
transaction takes its snapshot before the lock is granted, so queued callers
still abort on serialization failure even though they waited their turn. Twelve
concurrent top-ups produced eight `500`s. Mutual exclusion is the stronger
guarantee here, and once callers are genuinely serialized, SSI adds nothing but
aborts.

`ReadCommitted` is safe for this path specifically because the treasury has no
minimum balance to violate — it is the only account permitted to go negative —
so there is no invariant that a stale read could break, and the lock removes the
lost update.

## Consequences

Each path pays only for the contention it has. Transfers keep optimistic
concurrency and its throughput; top-ups get a queue, which is what a
single-row hotspot wants.

Costs:

- Two mechanisms to understand instead of one, and a reader who sees
  `ReadCommitted` on a money path will reasonably suspect a mistake. The code
  carries the reasoning inline for that reason.
- The advisory lock is only as good as its discipline: it serializes writers
  that take it, and nothing else. Test fixtures that wrote the treasury without
  it produced a real 2 300 000-tiyin drift in the development database — the
  failure this ADR exists to prevent, arriving through the door nobody guarded.
  Fixtures now take the same lock.
- `40001` and `P2034` have to be distinguished from ordinary failures, or a
  retryable conflict is reported to the user as a fault.

## Alternatives rejected

**`Serializable` everywhere.** One rule, easy to state. Rejected on evidence:
measured 8 failures in 12 concurrent top-ups, because SSI cannot help a workload
whose every member touches the same row.

**`SELECT … FOR UPDATE` on the treasury.** Equivalent mutual exclusion and more
familiar than an advisory lock. Rejected narrowly: the advisory lock is not tied
to a row's visibility, so it also covers the case where the treasury row is
being inserted by a concurrent seed, and it needs no read to acquire.

**A queue or a single writer process.** Correct at scale and disproportionate
now: it introduces a component, a delivery guarantee and a failure mode, to
serialize an operation that is already serialized by one lock.

**Optimistic version column on `accounts`.** A hand-rolled version of what SSI
already provides, with the same contention profile on the treasury.

## Reversibility

**Easy per path.** Both are one argument and one statement inside
`TransferService`, with no schema or API implications, and the tests that pin
the behaviour are concurrency tests rather than shape assertions — so a change
would be caught rather than merely permitted. What is *not* easy is discovering
that the wrong choice was made: the symptom is intermittent, load-dependent, and
looks like a flaky test.
