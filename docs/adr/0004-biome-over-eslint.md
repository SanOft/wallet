# ADR-0004 — Biome replaces ESLint, typescript-eslint and Prettier

**Status:** Accepted — day 1
**Relates to:** NFR-6, `biome.json`

## Context

The spec asks for a linter and a formatter. The default answer is ESLint plus
typescript-eslint plus Prettier plus the plugins that make them agree — five
packages before any rule is configured.

This project pins TypeScript `7.0.2`, which is the **native Go port**. That
version does not ship `typescript.js`: there is no JavaScript compiler API to
import. `typescript-eslint` declares a peer dependency of `>=4.8.4 <6.1.0` on
TypeScript precisely because it consumes that API for type-aware rules.

So the usual stack is not merely heavier here — its type-aware half cannot run
at all. The options were to hold TypeScript back to 6.x, to install a second
TypeScript purely to satisfy the linter, or to lint with something that does not
need the compiler.

## Decision

Biome `2.5.10`, as one dependency covering both linting and formatting.

Rules are configured in `biome.json`, `yarn lint` runs `biome check .`, and
`yarn format` runs the same with `--write`. Formatting is checked in CI, so a
disagreement is a failed build rather than a review comment.

## Consequences

One dependency instead of roughly five, one config file instead of three, and no
`eslint-config-prettier`-shaped layer whose entire job is stopping two tools
from fighting. Biome is fast enough that `yarn lint` runs first in `yarn verify`
— 57 files in about 55 ms — which is why the cheapest gate is also the first
one.

The cost is real and worth stating plainly:

- **No type-aware rules.** `no-floating-promises`, `no-misused-promises` and
  their relatives do not exist here, because they need the type checker. This
  project's mitigation is that `tsconfig.base.json` runs strict plus eight
  further flags, and `yarn typecheck` covers tests as well as sources — but that
  is not the same coverage, and an unawaited promise can still slip through.
- Biome's rule set is smaller than ESLint's ecosystem, and there is no rule for
  the §8.2 dependency direction. That is currently held by review and tracked as
  P-10.
- Rule names differ from ESLint's, so existing knowledge does not transfer
  directly.

## Alternatives rejected

**ESLint + typescript-eslint.** The type-aware rules are the reason to want it,
and they are exactly the part that cannot run against TypeScript 7's native
port. Rejected on that basis rather than on preference.

**Hold TypeScript at 6.x.** Would restore the option, at the price of pinning
the language version of a greenfield project to the constraint of a lint plugin.
Rejected: the tail should not wag the dog, and E6 asks for the newest stable
features the installed versions allow.

**Install a second TypeScript for the linter only.** Two compilers in one
lockfile, disagreeing about semantics, to get a subset of rules. Rejected as
worse than the gap it fills.

**oxlint.** Fast, and formatting is a separate concern again, which puts the
count back up.

## Reversibility

**Easy.** Both tools read the same sources and neither is imported by
application code. Switching back is a dev-dependency change, a config file and
one reformat commit — and it becomes attractive the moment typescript-eslint
supports the native port, at which point this record should be revisited rather
than assumed still true.
