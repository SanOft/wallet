import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import type { Env } from "../config/env.js"

/**
 * Prisma 7 connects through a driver adapter rather than reading the URL from
 * the schema, so the connection string is supplied here from validated config
 * (spec §20.2) instead of being picked up implicitly from the environment.
 *
 * The client is created by a factory, not exported as a module-level singleton,
 * so a test can stand up its own against a throwaway database without the
 * import graph forcing a connection to the real one.
 */
/**
 * Takes only the field it reads. Widening this to the whole `Env` made the seed
 * script — which needs a connection string and nothing else — refuse to run
 * without a JWT secret, in the one situation where it matters most: a fresh
 * database, before anything else is configured.
 */
export function createPrismaClient(env: Pick<Env, "DATABASE_URL">): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({ adapter })
}

export type DatabaseHealth =
  | { readonly ok: true; readonly migration: string | null }
  | { readonly ok: false; readonly error: string }

interface MigrationRow {
  readonly migration_name: string
}

/**
 * Answers two questions `/health` needs: is the database reachable, and which
 * migration is this database actually on (runbook T-2.5).
 *
 * The migration name matters during a deploy window, when the API and the
 * schema are briefly out of step (§19.1) — "up" is not a useful answer if the
 * process is talking to a database one migration behind.
 */
export async function checkDatabase(prisma: PrismaClient): Promise<DatabaseHealth> {
  try {
    const rows = await prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `
    return { ok: true, migration: rows[0]?.migration_name ?? null }
  } catch (error) {
    // The message is for the operator reading /health, so it says what failed
    // without leaking the connection string.
    return { ok: false, error: error instanceof Error ? error.name : "UnknownError" }
  }
}
