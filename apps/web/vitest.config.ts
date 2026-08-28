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
