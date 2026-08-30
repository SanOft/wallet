import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    /*
     * Once per run, not per file: resets the database the suites share and
     * refuses to start at all if CI has no database to point at (P-17).
     */
    globalSetup: ["./test/global-setup.ts"],
    // Integration tests share one database; running files in parallel would let
    // them observe each other's rows.
    fileParallelism: false,

    /**
     * Vitest's default is five seconds, and this suite outgrew it.
     *
     * Every registration and every sign-in spends about 44 ms in argon2 by
     * design (`crypto.ts` documents the figure), and several tests do dozens
     * of each against a real database. `yarn verify` runs this suite and the
     * web one at the same time on the same machine, so the work is the same
     * and the clock is not.
     *
     * The symptom is the one P-38 records on the web side: a varying set of
     * tests, different ones each run, failing with `Test timed out in 5000ms`
     * rather than an assertion — three in one run, none in the next four. The
     * web config was given twenty seconds for exactly this in #59; the API
     * config was left on the default, which is the inconsistency rather than
     * the number.
     *
     * A budget is not a way to make slow work pass. Every test here asserts an
     * end state, never a latency, so a larger budget costs nothing on success
     * and only makes a genuinely stuck test slower to say so — which is the
     * right side of that trade. The tests that declare thirty seconds keep
     * theirs; a declared budget always wins.
     */
    testTimeout: 20_000,

    /**
     * NFR-6: domain (transfer and ledger) at 90%, overall at 70%.
     *
     * Enforced rather than reported. A coverage number nobody gates on is a
     * number that only ever goes down, and two reviews had already flagged the
     * target as an aspiration with no instrument.
     */
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        "src/domain/**": {
          lines: 90,
          functions: 90,
          statements: 90,
          /**
           * NFR-6 asks for "90%" without naming a metric, and lines,
           * statements and functions all clear it. Branch coverage is the
           * strictest of the four and sits at 78%: what is uncovered is the
           * serialization-retry ladder and the unique-violation recovery,
           * which need fault injection at the driver level rather than more
           * scenarios. Set to the measured floor so a regression is caught,
           * with the gap recorded rather than papered over.
           */
          branches: 78,
        },
      },
    },
  },
})
