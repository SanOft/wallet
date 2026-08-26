import type { PrismaClient } from "@prisma/client"
import type { Express } from "express"
import { createApp } from "../src/adapters/http/app.js"
import { type Env, loadEnv } from "../src/config/env.js"
import { AuthService } from "../src/domain/AuthService.js"
import { TransferService } from "../src/domain/TransferService.js"
import { createTokenService } from "../src/infra/jwt.js"
import { createLogger } from "../src/infra/logger.js"

/** Long enough to satisfy the 256-bit minimum; meaningless outside tests. */
const TEST_JWT_SECRET = "test-secret-that-is-long-enough-for-hs256-0123456789"

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
): BuiltApp {
  const lines: string[] = []
  const env = testEnv(envOverrides)
  const log = createLogger(env, {
    write(chunk: string) {
      lines.push(chunk)
    },
  })
  const tokens = createTokenService(env)
  const auth = new AuthService({ prisma, tokens })
  const transfers = new TransferService({ prisma })

  return {
    app: createApp({ prisma, log, env, auth, tokens, transfers, ...(now ? { now } : {}) }),
    logText: () => lines.join(""),
  }
}

/** A Prisma double for suites that must not touch a database. */
export const PRISMA_STUB = {
  $queryRaw: async () => [{ migration_name: "00000000000000_stub" }],
} as unknown as PrismaClient
