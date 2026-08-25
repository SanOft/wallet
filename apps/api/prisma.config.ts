import { fileURLToPath } from "node:url"
import { defineConfig, env } from "prisma/config"

/**
 * Prisma 7 moved the connection URL out of `schema.prisma`: the schema now
 * describes shape only, and everything environment-dependent lives here.
 *
 * Prisma no longer reads `.env` on its own either, so we load it explicitly and
 * tolerate its absence — in CI and on Render the variables come from the
 * platform, and a missing file there is expected rather than an error.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)))
} catch {
  // No local .env; the environment is expected to supply DATABASE_URL.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --env-file-if-exists=.env prisma/seed.ts",
  },
})
