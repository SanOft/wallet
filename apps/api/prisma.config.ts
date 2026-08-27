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
const preset = { ...process.env }
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)))
} catch {
  // No local .env; the environment is expected to supply DATABASE_URL.
}
/*
 * `.env` fills gaps; it does not overwrite what the caller already set.
 *
 * `process.loadEnvFile` overrides, which makes every Prisma command ignore an
 * inline variable — `DATABASE_URL=... prisma migrate deploy` silently runs
 * against whatever `.env` says instead. That is not a theoretical complaint:
 * it sent a migration to the wrong database while a second one was being set
 * up, and the only symptom was "No pending migrations to apply" from a command
 * that had been pointed somewhere else entirely.
 */
for (const [key, value] of Object.entries(preset)) {
  if (value !== undefined) process.env[key] = value
}

/**
 * Migrations connect directly; the application connects through the pooler.
 *
 * Neon serves two hostnames for the same database — one with `-pooler` and one
 * without — and its Prisma guide is explicit that `migrate deploy` needs the
 * direct one. A migration takes advisory locks and issues DDL across several
 * statements, and a transaction pooler is free to hand those statements to
 * different backends. The failure is not a clean refusal: it is a migration
 * that half-applies.
 *
 * `DATABASE_URL` stays the pooled string, because that is what the running
 * service wants. Falling back to it keeps CI and local development working,
 * where there is no pooler and the two are the same host.
 */
const migrationUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? ""

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: migrationUrl || env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --env-file-if-exists=.env prisma/seed.ts",
  },
})
