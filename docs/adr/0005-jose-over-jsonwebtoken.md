# ADR-0005 — `jose` for JWTs, with the algorithm pinned in both directions

**Status:** Accepted — day 3
**Relates to:** FR-2.4, NFR-1.3, §17.1, `apps/api/src/infra/jwt.ts`

## Context

Access tokens are stateless JWTs (FR-2.4). The default library for this in Node
is `jsonwebtoken`, which pulls in roughly ten transitive packages.

The more important question is not which library but how it is called. JWT's
best-known failure mode is algorithm confusion: a verifier that trusts the
token's own `alg` header can be handed `alg: none`, or an RS256 verifier can be
fed an HS256 token signed with the public key it publishes. Both turn
verification into a formality. Both are configuration mistakes, not library
bugs, and both are easy to make because the permissive behaviour is the one that
"works" in testing.

## Decision

`jose` `6.2.10`, which has **zero dependencies**, and the algorithm is pinned on
signing and verification alike:

- Signing sets `HS256` explicitly.
- Verification passes `algorithms: ["HS256"]`, so anything else — including
  `none` — is rejected before the signature is examined.
- `issuer` and `audience` are asserted, so a token minted for something else
  does not authenticate here.

The pin is tested from the attacker's side: the suite forges a token with a
different algorithm and asserts verification fails, rather than only asserting
that a good token passes.

## Consequences

Ten packages removed from the supply chain for one of the most
security-sensitive paths in the system. Every package in a dependency tree is a
place a compromise can enter (`event-stream`, `ua-parser-js`, and the rest), and
"fewer dependencies" is a security property, not an aesthetic one.

`jose` is promise-based and Web Crypto-based, so signing and verification are
`await`ed. It targets the standards rather than a Node-specific API, which makes
it portable to workers and edge runtimes if the deploy target ever moves.

Costs:

- The API is less forgiving. Options are objects and mistakes are type errors
  rather than silently permissive defaults — which is the point, but it means
  the migration from `jsonwebtoken` examples found online is not mechanical.
- Being async, a synchronous verification helper is not available; every call
  site is already async here, so this cost is currently zero.

## Alternatives rejected

**`jsonwebtoken`.** Ubiquitous and well understood. Rejected for its dependency
surface, given that the same job is done by a zero-dependency package with a
stricter API.

**Node's built-in `crypto` directly.** No dependency at all, and it means
hand-writing base64url encoding, canonical JSON, constant-time comparison and
claim validation. Rejected: this is the category of code where a subtle bug is
invisible and catastrophic, and where a maintained library is worth more than
the dependency it costs.

**Opaque random tokens in a database.** Removes JWT's whole failure class and
gives immediate revocation — which is the exact gap tracked as P-16, where an
access token outlives revocation by up to fifteen minutes. Rejected for the
access token because it puts a database read on every authenticated request; it
is what refresh tokens already do, which is why refresh revocation *is*
immediate. If P-16 is closed with a `tokensValidAfter` check, that read comes
back for money endpoints only, which is the intended compromise.

## Reversibility

**Easy.** Token creation and verification are behind `infra/jwt.ts` and nothing
else imports a JWT library. Swapping the implementation is one file. Changing
the token *format* — to opaque tokens — is harder, because it changes the
client's storage model and the refresh flow, but the seam is in the same place.
