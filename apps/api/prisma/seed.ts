import { fileURLToPath } from "node:url"
import type { PrismaClient } from "@prisma/client"
import { createPrismaClient } from "../src/infra/prisma.js"

/**
 * Treasury seed (spec §9.4, runbook T-2.8).
 *
 * There is no real money, but double-entry must still hold: every credit comes
 * from somewhere. The TREASURY account is that somewhere — the mint for demo
 * funds, and the only account the database permits to go negative. Without it
 * a top-up would have to create value out of nothing and break I-1.
 *
 * Idempotent by construction: both writes are upserts keyed on a unique column,
 * so running this against a seeded database is a no-op rather than a duplicate.
 */

/**
 * Never used to sign in (§4). The hash is a sentinel, not a credential.
 *
 * Exported so the test that proves nobody can pay the mint uses this number
 * rather than a copy of it: the guard it exercises is worthless if the two ever
 * drift apart.
 */
export const SYSTEM_PHONE = "+998000000000"
const SYSTEM_PASSWORD_HASH = "!system-account-cannot-authenticate!"
const TREASURY_CURRENCY = "UZS"

/**
 * The one variable this script needs, checked here rather than by the full
 * boot-time schema. A seed that demands a JWT secret cannot run in the one
 * place it is most needed — a fresh deploy, before anything else is set.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to seed")
  return url
}

export async function seed(
  injected?: PrismaClient,
): Promise<{ userId: string; accountId: string }> {
  // Seeding needs a connection string and nothing else. This comment has been
  // here since the CI failure it describes, while the line below went on
  // calling `loadEnv()`, which validates JWT_SECRET, CORS_ORIGINS and the rest
  // — so seeding still refused to run without a secret it never uses. Now the
  // code does what the comment says.
  const prisma = injected ?? createPrismaClient({ DATABASE_URL: connectionString() })

  try {
    const system = await prisma.user.upsert({
      where: { phone: SYSTEM_PHONE },
      update: {},
      create: {
        phone: SYSTEM_PHONE,
        firstName: "Wallet",
        lastName: "System",
        passwordHash: SYSTEM_PASSWORD_HASH,
        role: "SYSTEM",
      },
    })

    const treasury = await prisma.account.upsert({
      // `userId + currency` is unique, which is what makes a second run a no-op
      // instead of a second treasury.
      where: { userId_currency: { userId: system.id, currency: TREASURY_CURRENCY } },
      update: {},
      create: {
        userId: system.id,
        currency: TREASURY_CURRENCY,
        type: "TREASURY",
        balance: 0n,
      },
    })

    return { userId: system.id, accountId: treasury.id }
  } finally {
    // Only close what we opened; a caller's client is theirs to manage.
    if (!injected) await prisma.$disconnect()
  }
}

// Only self-executes when run directly, so the integration tests can import
// `seed()` without the module also trying to run itself.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(({ userId, accountId }) => {
      console.log(`SYSTEM user ${userId}`)
      console.log(`TREASURY account ${accountId}`)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
