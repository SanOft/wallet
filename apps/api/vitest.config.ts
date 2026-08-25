import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Integration tests share one database; running files in parallel would let
    // them observe each other's rows.
    fileParallelism: false,
  },
})
