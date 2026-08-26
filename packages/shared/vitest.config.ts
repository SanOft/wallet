import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    /**
     * NFR-6's "overall >= 70%" has to include this package. It was measured
     * only in `apps/api`, so every contract helper — the money formatting, the
     * limits, and `maskRecipientName`, which carries FR-4.6 — sat outside the
     * gate entirely. That is a large part of why two masking bugs shipped.
     */
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
})
