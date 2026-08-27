# ADR-0002 — Money is `BIGINT` minor units, carried over JSON as strings

**Status:** Accepted — day 1
**Relates to:** spec §9.3, NFR-1.10, `packages/shared/src/money.ts`

## Context

JavaScript has one number type, IEEE 754 double precision. It cannot represent
`0.1` exactly, and it loses integer precision above 2^53. Both matter here: the
first makes arithmetic on decimal so'm wrong in ways that accumulate, and the
second is not as far away as it looks — 2^53 tiyin is about 90 billion so'm,
which a treasury account in a demo reached within a week of testing.

The second decision is how money crosses the wire. `JSON.parse` produces a
`number`, so a large `BIGINT` sent as a JSON number is silently rounded by the
client's own parser before any application code sees it.

## Decision

Amounts are `BIGINT` in the database and `bigint` in TypeScript, always in the
currency's **minor unit** — tiyin for UZS, cents for USD.

Over JSON they are **strings** of digits: `"300000"` is 3 000 so'm. The schema
that parses them is strict about the representation — no leading zeros, no sign,
no decimal point, no exponent, ASCII digits only. One value has exactly one
spelling, which matters because an idempotency key is hashed together with the
payload: `"0100"` and `"100"` must not be two different requests for the same
money.

Formatting reads two separate numbers from a currency registry (`CURRENCIES`),
and neither is hard-coded.

`exponent` is how many minor units make one major unit — 2 for UZS, because a
tiyin is a hundredth of a so'm. `displayDecimals` is how many of them a user is
shown, and for UZS that is **0**: prices are not quoted in tiyin and nobody
writes them, so `formatMoney(125_000_000n, "UZS")` renders `1 250 000 so'm`
rather than `1 250 000,00`.

Keeping them apart is the point. Collapsing them into one number — the obvious
simplification, since most currencies have `exponent === displayDecimals` — is
what produces a UI that either shows two zeros nobody wants or an amount
divided by the wrong power of ten.

## Consequences

Money cannot be added to a number by accident; TypeScript refuses to mix
`bigint` and `number`. Prisma returns `BIGINT` as `bigint`, so the type survives
the round trip.

Costs:

- `JSON.stringify` throws on a `bigint`. Every response has to convert
  explicitly, which is a nuisance and also the reason the wire format is
  unambiguous.
- Aggregates need care: `SUM(bigint)` in Postgres returns `numeric`, not
  `bigint`, and Prisma hands that back as a type that will not mix with
  `bigint`. Every aggregate in raw SQL carries an explicit `::bigint`. This cost
  one debugging session before it was understood.
- Division is integer division. Nothing in the current feature set divides
  money; when exchange rates arrive (FR-7), rounding becomes a decision that
  needs its own record.

## Alternatives rejected

**`number` with two decimal places.** Rejected outright: it is wrong, and it is
wrong quietly.

**`decimal.js` or `big.js`.** Correct, and a dependency plus a wrapper type on
every arithmetic site. `bigint` is a language primitive that does the same job
for integers, and money in minor units is an integer.

**Postgres `NUMERIC` with `Decimal` in the client.** Genuinely defensible, and
what a bank ledger with fractional interest would want. Rejected because a
payments wallet moves whole minor units, and `NUMERIC` costs both storage and
the ability to use the type system to prevent mixing.

**Sending numbers over JSON and relying on the client.** Rejected: the rounding
happens inside `JSON.parse`, before any code of ours could validate it.

## Reversibility

**Moderate.** The database column type is a migration and the wire format is a
breaking API change, but both are mechanical because every amount already passes
through one schema in `packages/shared`. The type system would locate every
site. The thing that would be expensive is going the other way — starting with
`number` and discovering the problem after a year of stored data.
