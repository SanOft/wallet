import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
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
