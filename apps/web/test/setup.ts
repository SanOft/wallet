import { afterEach } from "vitest"

/**
 * Two of the suites here read files and touch no DOM, so they declare
 * `@vitest-environment node`. This file runs for every suite regardless, which
 * means everything below has to be conditional: reaching for `window` in the
 * node environment turns a passing test file into a collection error, and the
 * message names this line rather than the test that failed.
 */
if (typeof window !== "undefined") {
  await import("@testing-library/jest-dom/vitest")

  /**
   * Testing Library registers its own cleanup only when Vitest globals are on.
   * They are off here — an implicit `describe` is one more thing a reader has
   * to know — so the teardown is wired explicitly. Without it every render
   * stacks in the same document and the second test in a file queries a page
   * holding three copies of the shell.
   */
  const { cleanup, configure } = await import("@testing-library/react")
  afterEach(cleanup)

  /**
   * Three seconds instead of one for the async queries.
   *
   * Not a way to make a slow assertion pass: every one of these suites asserts
   * an end state, never a latency. What changed is how much genuinely
   * asynchronous work happens before that state exists. A screen now waits for
   * its lazily-loaded chunk (F6.1) and for the IndexedDB read that may hold a
   * cached value (FR-8.2) before it can paint, and `yarn verify` runs the API
   * and web suites at the same time on the same machine.
   *
   * Under that load the one-second default expired at random — twice in five
   * runs, in different files each time. A test that fails on a busy laptop and
   * passes on an idle one teaches people to press re-run, which is how a real
   * failure gets pressed past too.
   *
   * **Raised from 3 000 to 10 000 (P-38).** The same symptom came back at the
   * higher threshold, with the same signature: a varying set of four tests,
   * different ones each run, all expiring between 3 200 and 5 200 ms. It is
   * reproducible rather than folklore —
   *
   *     for i in 1 2; do (yarn vitest run --coverage=false &) ; done
   *
   * — fails 2/2 that way and passes 6/6 without contention. Nothing in the
   * path waits on a timer, so the only variable is how much CPU the chain
   * gets.
   *
   * The chain keeps growing, which is the real story: the transfer wizard
   * gained a recent-recipients query and the accounts response gained the
   * daily allowance, so the wizard now waits on strictly more than it did.
   * A budget sized for last month's chain converts load into false failures.
   *
   * The cost is bounded and falls on the right side. `waitFor` returns the
   * moment its condition holds, so a passing test pays nothing for a larger
   * budget; only a genuinely broken one waits longer to say so. Slow true
   * failures beat fast false ones.
   */
  configure({ asyncUtilTimeout: 10_000 })

  /**
   * jsdom implements no layout engine, so `matchMedia` is absent. Anything that
   * asks about the colour scheme would throw rather than fall back. Defaulting
   * to "does not match" makes the light theme the one under test unless a test
   * says otherwise, which is the same default the stylesheet takes.
   */
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}
