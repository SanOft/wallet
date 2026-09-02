/**
 * The contract between every budget in this directory and the control that
 * proves it can fail.
 *
 * Its own file because both sides need it and neither can import the other:
 * a budget is a top-level script that runs on import, so requiring one from a
 * control would run it. Copying the numbers into both would work until one of
 * them changed.
 *
 * The distinction these encode is the point. "Over budget" and "could not
 * measure" are both non-zero, and a control that reads only "non-zero" passes
 * when the measurement crashes — which is exactly what happened on the
 * Lighthouse control's first run in CI, and is the same shape as the five
 * privilege assertions in this repository that passed on a connection error
 * instead of on a refusal.
 */

/** The artefact was measured, and it breaks the budget in docs/spec.md NFR-2.1. */
export const EXIT_OVER_BUDGET = 2

/**
 * No verdict was reached: the measurement failed to run, or the build came
 * back in a shape the budget does not recognise. Says nothing about the build.
 */
export const EXIT_CANNOT_MEASURE = 1
