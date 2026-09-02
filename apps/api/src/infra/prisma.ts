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

/**
 * What the connecting role is allowed to do (P-4).
 *
 * ADR-0001 puts the ledger's invariants in the database so a bug in service
 * code cannot corrupt them, and that argument holds only against a role which
 * cannot rewrite the rules. `prisma/runtime-role.sql` creates one; whether the
 * deployment actually *uses* it is a fact about the environment that the code
 * cannot know, and until now nothing said either way.
 *
 * Reported at startup rather than on `/health`. The proxy-hop count is on
 * `/health` because a count of forwarded-for entries tells an attacker nothing;
 * "this API connects as a superuser" tells them the blast radius of compromising
 * it, which is exactly the thing not to publish. An operator reads the deploy
 * log anyway.
 */
export interface ConnectionPrivileges {
  readonly role: string
  readonly superuser: boolean
  /** Tables in `public` owned by this role. The runtime role must own none. */
  readonly ownedTables: number
}

interface PrivilegeRow {
  readonly role: string
  readonly superuser: boolean
  readonly owned: bigint
}

export async function checkPrivileges(prisma: PrismaClient): Promise<ConnectionPrivileges | null> {
  try {
    const rows = await prisma.$queryRaw<PrivilegeRow[]>`
      SELECT current_user::text                                  AS "role",
             COALESCE(r.rolsuper, false)                         AS "superuser",
             (SELECT count(*) FROM pg_tables
               WHERE schemaname = 'public'
                 AND tableowner = current_user)                  AS "owned"
        FROM pg_roles r
       WHERE r.rolname = current_user
    `
    const row = rows[0]
    if (!row) return null

    return { role: row.role, superuser: row.superuser, ownedTables: Number(row.owned) }
  } catch {
    /*
     * Never fatal. This is a diagnostic about the deployment, and a service
     * that refused to boot because it could not read `pg_roles` would be an
     * outage caused by a report.
     */
    return null
  }
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
