import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      /*
       * `vite-plugin-pwa` provides this module, and this config does not load
       * that plugin — the tests would otherwise fail on an unresolved import
       * for a module that exists only in a real build.
       *
       * The cost is that the stub's shape is not checked against the real
       * one; `src/vite-env.d.ts` references the plugin's types so the
       * *component* still is, which is where a mismatch would actually bite.
       */
      "virtual:pwa-register/react": fileURLToPath(
        new URL("./test/stubs/pwa-register.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],

    /*
     * Above `asyncUtilTimeout` (10 000, `test/setup.ts`), deliberately.
     *
     * The two budgets are ordered, and the order is the whole point. When
     * `waitFor` expires first it fails with the assertion — "expected the
     * balance card to contain 1 250 000" — which names the screen, the value
     * and the test. When Vitest's own timeout expires first it fails with
     * "Test timed out in 5000ms", which names nothing and sends the reader to
     * a stack trace pointing at the `it`.
     *
     * That is exactly what happened while diagnosing P-38: raising
     * `asyncUtilTimeout` alone lifted it past the 5 000 ms default and turned
     * four informative failures into five useless ones. A timeout is a
     * diagnostic, so the one that fires first has to be the one that knows
     * what it was waiting for.
     */
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The entry point is three lines of DOM wiring with nothing to assert.
      exclude: ["src/main.tsx"],
      /**
       * NFR-6 asks for 70% overall. F0 is a token system and a shell, so the
       * number here measures how much of that shell the accessibility and
       * rendering tests actually touch — it rises as screens arrive, and this
       * floor stops it falling while they do.
       */
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
})
