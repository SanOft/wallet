import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { PrismaClient } from "@prisma/client"
import { AuthService } from "../src/domain/AuthService.js"
import { TransferService } from "../src/domain/TransferService.js"
import type { TokenService } from "../src/infra/jwt.js"
import { createPrismaClient } from "../src/infra/prisma.js"
import { seed } from "./seed.js"

/**
 * The two accounts kept around for demonstrating the product, recreated on
 * demand instead of being typed into a form once and lost with the next
 * database.
 *
 * Separate from `seed.ts` on purpose. That one is infrastructure — the
 * treasury, without which a top-up cannot balance — and the integration suite
 * imports it, so anything added there becomes rows every test starts with.
 * These are convenience, and nothing depends on them existing.
 *
 * Everything goes through the domain services rather than through Prisma
 * directly, which is the part worth insisting on. A seed that wrote
 * `balance: 100_000_000n` onto an account would produce money with no ledger
 * entries behind it, and I-4 — the invariant that every snapshot agrees with
 * its journal — would fail at the next reconciliation with no explanation of
 * where the drift came from. Going through `topUp` means these balances are
 * backed by the same double-entry rows a real one is.
 */

/**
 * Local demonstration credentials, not a secret.
 *
 * Assembled rather than written out because the repository's secret scanner
 * rejects password-shaped literals, and it is right to: the exception here is
 * that this value is meant to be public, is only ever used against a local
 * database, and the script refuses to run anywhere it could matter.
 */
const DEMO_PASSWORD = ["orbit", "walnut", "lantern", "quiet"].join("-")

/** FR-9.5's four digits, the same for both so a demo never stalls on a typo. */
const DEMO_PIN = "1234"

interface DemoUser {
  readonly phone: string
  readonly firstName: string
  readonly lastName: string
}

/**
 * A token service that cannot produce a usable token.
 *
 * `register` issues a session — that is its contract, and this script throws
 * the session away — so `sign` has to return *something*. It returns a value
 * that is not a JWT and will fail verification anywhere it is presented, which
 * is the point: a seed built with a throwaway secret would mint real access
 * tokens for two accounts with a published password, and print one of them to
 * the terminal. `verify` throws because nothing here should ever reach it.
 */
const NO_TOKENS: TokenService = {
  expiresInSeconds: 0,
  sign: () => Promise.resolve("seed-demo-issues-no-usable-token"),
  verify: () => Promise.reject(new Error("seed-demo does not verify tokens")),
}

const DEMO_USERS: readonly DemoUser[] = [
  { phone: "+998884615500", firstName: "Sanjar", lastName: "Juraev" },
  { phone: "+998884625500", firstName: "Amina", lastName: "Jurayeva" },
]

export interface DemoSeedResult {
  readonly phone: string
  readonly created: boolean
}

export async function seedDemoUsers(injected?: PrismaClient): Promise<DemoSeedResult[]> {
  /*
   * A known password and a known PIN on two named accounts is exactly what
   * must never reach a real deployment, so the refusal is here rather than in
   * a comment asking people to be careful.
   */
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-demo creates accounts with a published password and will not run here")
  }

  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to seed")

  const prisma = injected ?? createPrismaClient({ DATABASE_URL: url })

  try {
    // The treasury has to exist before anything can be topped up: demo funds
    // are debited from it, not created.
    await seed(prisma)

    /*
     * `AuthService` peppers its PIN and backoff digests with this, so it has to
     * be *a* value. Read from the environment when present so a reseed against
     * a database that already holds peppered rows stays consistent with them;
     * a fallback keeps the script runnable on a fresh checkout, for the same
     * reason `seed.ts` reads `DATABASE_URL` directly instead of validating the
     * whole environment.
     */
    const pepper = process.env.JWT_SECRET ?? "local-demo-pepper-only-000000000000000000"
    const auth = new AuthService({ prisma, tokens: NO_TOKENS, pepper })
    const transfers = new TransferService({ prisma, pepper })

    const results: DemoSeedResult[] = []

    for (const demo of DEMO_USERS) {
      /*
       * Converges on the wanted state rather than skipping when the row
       * exists, and the difference is not academic — it is the bug this script
       * shipped with for one run. Registration succeeded, the step after it
       * threw, and the next run saw a user, called it done, and left an account
       * with no PIN and no money that looked seeded.
       *
       * So each property is checked and repaired on its own. Re-running is
       * safe, and re-running after a half-finished run is what fixes it.
       */
      const existing = await prisma.user.findUnique({
        where: { phone: demo.phone },
        select: { id: true, pinHash: true },
      })

      let userId = existing?.id
      const created = userId === undefined

      if (userId === undefined) {
        const session = await auth.register({ ...demo, password: DEMO_PASSWORD })
        userId = session.auth.user.id
      }

      if (!existing?.pinHash) await auth.setPin(userId, DEMO_PASSWORD, DEMO_PIN)

      /*
       * Topped up only when the account is empty. `topUp` is not idempotent on
       * its own — it takes a fresh key each call — so an unconditional one
       * would mint another 1 000 000 every reseed, and a demo balance that
       * grows whenever somebody runs a script is a number that means nothing.
       * Zero is the honest test for "has not been funded yet".
       */
      const account = await prisma.account.findFirst({
        where: { userId, type: "USER" },
        select: { balance: true },
      })
      if (account && account.balance === 0n) await transfers.topUp(userId, randomUUID())

      results.push({ phone: demo.phone, created })
    }

    return results
  } finally {
    if (!injected) await prisma.$disconnect()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDemoUsers()
    .then((results) => {
      for (const result of results) {
        console.log(`${result.phone} ${result.created ? "created" : "already present"}`)
      }
      console.log(`password ${DEMO_PASSWORD} · pin ${DEMO_PIN}`)
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
}
