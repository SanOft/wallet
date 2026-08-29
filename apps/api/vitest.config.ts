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
