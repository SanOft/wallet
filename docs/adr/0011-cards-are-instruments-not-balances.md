# ADR-0011 — A card is a payment instrument, not a balance

**Status:** Proposed — before the card work
**Relates to:** spec §9.1, §9.3, §9.4, FR-3, FR-4, ADR-0001, ADR-0006, `apps/api/prisma/schema.prisma`

## Context

Adding cards forces a question the schema has so far been able to leave
implicit: when a user registers a card, what is it?

There are two coherent answers and they are not close together. Either a card
is another place money sits — a thing with a balance, which the user tops up
and spends from — or it is a way to reach money that sits somewhere else, which
holds nothing and is only ever a route.

The question has to be settled before the first migration, because the two
answers produce different tables and the ledger's guarantees depend on which
one is chosen. `@@unique([userId, currency])` on `Account` currently states one
account per user per currency, and nothing in the codebase has yet had a reason
to disagree with it.

The same question reaches a second one, which is why this record covers both:
if a user can have several places money sits, do they get several *accounts* —
the Monzo Pots and Revolut Vaults model — and if so, when?

## Decision

**Money lives in `Account`. A card is a payment instrument: a pointer to an
external funding rail, carrying `brand`, `last4` and a provider token, and never
a balance of its own.**

For the MVP a user has one account per currency, which is what the existing
constraint already says. Cards do not change that count. Registering three cards
gives a user three ways to reach one balance, not three balances.

A payment method therefore stores what is needed to identify the instrument to a
human (`brand`, `last4`) and to the provider (a token), and nothing that could
be mistaken for money. There is no `balance` column on it, and that absence is
the decision.

**A payment method links to an `accountId`, not to a `userId`** — from the
start, while there is exactly one account it could possibly point at. The
reasoning is in Consequences, and it is the part of this record most likely to
look like over-engineering and most expensive to add later.

## Consequences

The ledger is untouched by cards. `LedgerEntry` rows continue to reference an
`accountId` and a `transferId`, the COMMIT-time trigger continues to check that
a `COMPLETED` transfer produced exactly two entries summing to zero (ADR-0001),
and a card funding a transfer is a transfer between two accounts like any other.
Nothing in §9.5's invariants acquires a special case for cards.

`reconciliation.ts` keeps one question to ask. Its query groups `ledger_entries`
by `accountId` and compares each account's cached `balance` against
`SUM(amount)` over its journal. Every place money is held has to appear on both
sides of that comparison. An instrument that holds nothing appears on neither,
so adding cards adds no rows to reconcile.

The cost is that a card can never be shown with a balance, because it does not
have one, and a product that later wants "£40 on this card" would be asking for
the rejected model. That is intended: the number a card can honestly show is the
account's.

**The forward-looking part.** Linking a payment method to an `accountId` while
only one account exists per currency buys nothing today and is deliberate. The
pockets model below is a change to how an account is *resolved*, not to what the
ledger does — so if payment methods are keyed on `userId`, adopting pockets
later means re-modelling every one of them to decide which pocket a card funds.
Keyed on `accountId` from the start, the same change is additive: existing rows
already name the account they meant, and new ones name a different account.
One column, chosen once, is the difference between a migration that adds and a
migration that rewrites.

## Alternatives rejected

**Card-as-balance.** Each registered card holds its own money; a transfer debits
the chosen card.

Rejected on correctness, not on effort. It puts the ledger's job in a second
place that nothing reconciles, and the classic instrument-level defects follow
directly. Two instruments can be spent concurrently against what the user thinks
is one pot, which is a double-spend that no `CHECK` on either row would notice,
because each row is individually consistent. A card's balance drifts from the
journal exactly as an account's can — except there is no journal for it to
drift from, so the drift is undetectable rather than merely undetected. And
`reconciliation.ts`'s comparison loses its single answer: `SUM(ledger_entries)`
grouped by `accountId` has nothing to compare a card's number against.

The weight of that last point is the reason this is a correctness rejection.
`reconciliation.ts` exists *because* one cached snapshot per account is already
something that has to be proved daily — ADR-0001 records that a corrupted ledger
still returns plausible numbers and nothing throws. A second cache per card
multiplies a problem the project already treats as serious, and buys nothing in
return: a card that holds money is not a feature anybody asked for, it is a
consequence of modelling the instrument as a container.

**Pockets / spaces.** Several same-currency accounts per user, with `SELF`
transfers between them — Monzo Pots, Revolut Vaults.

This is the right eventual shape. It is deferred on cost, not rejected on merit,
and the cost is specific rather than vague.

Removing `@@unique([userId, currency])` means every place that resolves an
account by *user and currency* has to take an explicit `accountId` instead,
because the query stops having one answer. `TransferService.ts` has seven
`tx.account.findFirst` call sites and five of them are affected:

| Line | Resolves | Affected |
|---|---|---|
| 594 | sender, by `{ userId, currency, type: "USER" }` | yes |
| 600 | recipient, by `{ user: { phone }, currency, type: "USER" }` | yes |
| 779 | treasury, by `{ type: "TREASURY", currency }` | no |
| 783 | the topped-up account, by `{ userId, currency, type: "USER" }` | yes |
| 883 | sender, by `{ userId, currency, type: "USER" }` | yes |
| 888 | treasury, by `{ type: "TREASURY", currency }` | no |
| 895 | counterparty, by `{ user: { phone }, currency, type: "USER" }` | yes |

The two treasury lookups are unaffected because they are not keyed on a user at
all: a partial unique index permits exactly one treasury account (ADR-0001), so
`{ type: "TREASURY", currency }` keeps its single answer however many accounts a
user has.

The recipient lookups at 600 and 895 are worth separating from the rest. They
resolve *somebody else's* account by phone number, so an explicit `accountId`
is not available to thread down — the sender does not know the recipient's
pocket ids and must not. Those two need a different answer from the other three:
a designated account per user that inbound money lands in, which is a product
decision rather than a refactor, and is the second reason this is not a quiet
change.

`AccountService`'s `AccountOverview.accounts` is already a list, so the read
side needs less work than the write side — but every affected write path needs
the account chosen upstream and threaded down.

The USSD channel is the harder half, and it is the reason this is not a quiet
refactor. `resolveStep` in `adapters/ussd/steps.ts` parses a transfer as
`2*phone*amount*pin` — four segments — and rejects a fifth outright:
`if (rest.length > 0) return { kind: "unknown" }`. There is no step in which the
channel could ask which pocket to send from, and adding one changes the shape of
a session that FR-9.2 defines by its keypresses. A user with pockets on the web
and no way to choose one over USSD is a worse product than a user with neither.

And the honest part, which decided it: architecturally it would demonstrate
**nothing new**. The ledger already moves money between two arbitrary accounts —
`LedgerEntry` names an `accountId`, not a user — and a self-transfer between two
of a user's own accounts is still two entries summing to zero, so I-1 holds
unchanged and the COMMIT-time trigger needs no amendment. The ledger does not
assume one account per user. Only the resolution layer above it does. Pockets
would therefore cost a schema change, a threading change through every write
path, and a new USSD step, in exchange for a product feature and no
architectural evidence the ledger does not already provide.

Deferred until there is a product requirement for savings goals.

## Reversibility

**Easy in one direction, hard in the other.**

Adopting pockets later is additive: drop the unique constraint, thread an
`accountId` through the call sites named above, add the USSD step. Nothing
already written becomes wrong, and payment methods keyed on `accountId` migrate
without being re-decided — which is the whole reason for that key.

Moving to card-as-balance later is not reversible in any useful sense. It would
mean the ledger no longer accounts for all the money in the system, and there is
no migration back from a period during which balances existed outside the
journal: the history to reconstruct them from was never written.

**What would reopen this record.** Multi-currency conversion, which needs an
explicit FX transaction recording which rate applied to which transfer — the
doc comment on `RatesSnapshot` already anticipates exactly this, noting that
conversion "will need to record which rate applied to which transaction, which
is a different table from this one". Or a product requirement for savings goals,
which is the case pockets exist to serve.
