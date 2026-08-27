# Architecture decision records

One page per decision that a future reader could otherwise reverse by accident.

A decision earns a record here when undoing it would be expensive, when the
obvious-looking alternative is wrong for a reason that is not obvious, or when
the code has to look strange in order to be correct. Choices that are merely
conventional — Express, Vite, GitHub Actions — are in `spec.md` §8.4 and need no
argument.

Each record states what was decided, what it costs, what was rejected, and how
hard it would be to undo. That last part is the one most often left out and the
one most often needed.

| # | Decision | Status |
|---|---|---|
| [0001](0001-invariants-in-the-database.md) | The ledger's invariants live in the database, not in the service | Accepted — day 2 |
| [0002](0002-money-as-minor-units.md) | Money is `BIGINT` minor units, carried over JSON as strings | Accepted — day 1 |
| [0003](0003-client-state.md) | Redux Toolkit + RTK Query for client state | Proposed |
| [0004](0004-biome-over-eslint.md) | Biome replaces ESLint, typescript-eslint and Prettier | Accepted — day 1 |
| [0005](0005-jose-over-jsonwebtoken.md) | `jose` for JWTs, with the algorithm pinned in both directions | Accepted — day 3 |
| [0006](0006-two-isolation-strategies.md) | Serializable for transfers, advisory lock for top-ups | Accepted — day 5 |
| [0007](0007-sse-for-live-balance.md) | Server-sent events for live balance | Proposed |
| [0008](0008-frontend-architecture.md) | Frontend architecture | Proposed |
| [0009](0009-api-behind-the-web-origin.md) | The API is served through the web origin, not beside it | Accepted — day 6 |

**Accepted** means the code does this today. **Proposed** means the decision is
recorded before the work, so the reasoning is available when it starts — and so
it can be argued with while changing it is still free.
