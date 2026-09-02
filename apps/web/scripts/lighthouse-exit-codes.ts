/**
 * The contract between `lighthouse-budget.ts` and `lighthouse-control.ts`.
 *
 * Its own file because both sides need it and neither can import the other:
 * the budget is a top-level script that starts a server and runs on import, so
 * requiring it from the control would run it. Copying the numbers into both
 * would work until one of them changed.
 *
 * The distinction these encode is the point. "Over budget" and "could not
 * measure" are both non-zero, and a control that reads only "non-zero" passes
 * when the measurement crashes — which is exactly what happened on this file's
 * first run in CI, and is the same shape as the five privilege assertions in
 * this repository that passed on a connection error instead of on a refusal.
 */

/** The build was measured, and it is over the budget in docs/spec.md NFR-2.1. */
export const EXIT_OVER_BUDGET = 2

/**
 * No verdict was reached: Lighthouse failed to run, or a report came back
 * without an audit the budget names. Says nothing about the build.
 */
export const EXIT_CANNOT_MEASURE = 1
