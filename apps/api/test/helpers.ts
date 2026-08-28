import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { Express } from "express"
import { createApp } from "../src/adapters/http/app.js"
import { type Env, loadEnv } from "../src/config/env.js"
import { AuthService } from "../src/domain/AuthService.js"
import { RatesService } from "../src/domain/RatesService.js"
import { TransferService } from "../src/domain/TransferService.js"
import type { RateFetcher } from "../src/infra/cbu.js"
import { createTokenService } from "../src/infra/jwt.js"
import { createLogger } from "../src/infra/logger.js"

/**
 * Generated per run rather than written down.
 *
 * A literal here was flagged by gitleaks — correctly, on shape: a scanner
 * cannot tell a test constant from a real key, and the right answer is not to
 * teach it to ignore one but to stop having one. Generating it also removes
 * any chance of the same value drifting into a non-test path.
 */
const TEST_JWT_SECRET = randomBytes(32).toString("base64url")

export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    DATABASE_URL: "postgresql://unused",
    JWT_SECRET: TEST_JWT_SECRET,
    LOG_LEVEL: "info",
    ...overrides,
  })
}

export interface BuiltApp {
  readonly app: Express
  /** The bytes the logger actually wrote, for assertions about redaction. */
  readonly logText: () => string
}

/**
 * Builds the app exactly as `index.ts` does, so a test exercises the composed
 * pipeline rather than a bespoke one. The day 2 review found three defects that
 * survived precisely because every test assembled its own middleware stack.
 */
export function buildApp(
  prisma: PrismaClient,
  envOverrides: NodeJS.ProcessEnv = {},
  now?: () => number,
  /**
   * The rates upstream, defaulted to one that refuses.
   *
   * A test that reaches the real central bank is a test that fails on a train,
   * passes in CI on a good day, and quietly measures somebody else's uptime.
   * Refusing by default means the only way to exercise rates is to say so.
   */
  fetcher: RateFetcher = () => Promise.reject(new Error("no rates upstream in tests")),
): BuiltApp {
  const lines: string[] = []
  const env = testEnv(envOverrides)
  const log = createLogger(env, {
    write(chunk: string) {
      lines.push(chunk)
    },
  })
  const tokens = createTokenService(env)
  const auth = new AuthService({ prisma, tokens, pepper: env.JWT_SECRET })
  const transfers = new TransferService({ prisma })
  const rates = new RatesService({ fetcher })

  return {
    app: createApp({ prisma, log, env, auth, tokens, transfers, rates, ...(now ? { now } : {}) }),
    logText: () => lines.join(""),
  }
}

/** A Prisma double for suites that must not touch a database. */
export const PRISMA_STUB = {
  $queryRaw: async () => [{ migration_name: "00000000000000_stub" }],
} as unknown as PrismaClient
