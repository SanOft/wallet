# ADR-0008 — Frontend architecture

**Status:** Proposed — F0–F7 begin in September
**Relates to:** spec §13 (all subsections), §8.2, NFR-3, NFR-4

## Context

`apps/web` is an empty workspace. §13 already specifies the design system, the
screen map, the four-step wizard, the a11y requirements and a twelve-row
defensive-UX matrix — so what is missing is not the design but the shape of the
code that implements it.

Two constraints come from outside the frontend. §8.2 fixes the dependency
direction: `apps/web` may import `packages/shared` and never `apps/api`. And
every request and response schema already exists in `packages/shared` as Zod,
which means the client validates against the identical definition the server
enforces — the contract cannot drift, because there is only one copy.

## Decision

**Feature-first structure, not layer-first.**

```
src/
├── app/          store, router, providers
├── features/
│   ├── auth/     screens, slice, api hooks, tests
│   ├── transfer/ the four-step wizard
│   ├── history/  list, filters, detail
│   └── outbox/   the offline queue
├── components/   design-system primitives only
└── lib/          formatting, hooks with no feature knowledge
```

A folder per feature keeps a change to the wizard inside one directory. The
layer-first alternative — `components/`, `hooks/`, `slices/`, `pages/` — spreads
every change across four.

`components/` holds only primitives that carry no feature knowledge: Button,
Input, Money, StatusBadge. The test for whether something belongs there is
whether it could ship in a library for a different product.

**Tokens are the only source of style.** §13.2 defines three layers —
primitives, semantic, component — as CSS custom properties in `:root`, with the
Tailwind config binding to them rather than the reverse. Raw hex and px values
inside components are forbidden and the rule is enforced by a lint rule, not by
review, because this is exactly the rule that erodes one hurried commit at a
time.

**Routing carries state that must survive a reload.** History filters live in
the URL (FR-5.2), so a filtered view is linkable and the back button behaves.
Wizard state does not (§13.5): a half-finished transfer is deliberately lost.

**Every screen implements four states.** Loading, empty, error, offline —
§13.4 lists them per screen, and a screen without all four is incomplete rather
than nearly done. The offline banner is global.

## Consequences

A feature can be built, tested and reviewed as a unit, and a new contributor
looking for the transfer flow finds all of it in one place.

Costs:

- Shared code between features has no obvious home and drifts toward `lib/`
  until `lib/` becomes the junk drawer. Anything in `lib/` that names a domain
  concept belongs in a feature.
- Feature-first invites duplication that layer-first would have made obvious.
  This is the accepted trade: duplication is visible and cheap to fix, coupling
  is invisible and expensive.

## Alternatives rejected

**Layer-first.** Familiar, and it optimises for finding "all the hooks" — which
is not a thing anyone needs — at the cost of every real change touching four
directories.

**Atomic design (atoms / molecules / organisms).** The vocabulary generates
arguments about whether something is a molecule, and answers no question the
primitive-versus-feature test does not answer more directly.

**A monolithic `pages/` tree with colocated everything.** Works to about ten
screens; §13.3 already maps eleven, before the labs screen.

## Reversibility

**Easy while the directory is empty; hard after F3.** Moving files is
mechanical, but the import graph a structure produces is not, and by the time
the wizard, the outbox and the history filters exist they will have grown edges
that assume the current shape. This is the cheapest moment to disagree with this
record, which is why it is written before the work rather than after it.
