import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { Express } from "express"
import { expect } from "vitest"
import { createApp } from "../src/adapters/http/app.js"
import { type Env, loadEnv } from "../src/config/env.js"
import { AccountService } from "../src/domain/AccountService.js"
import { AuthService } from "../src/domain/AuthService.js"
import { RatesService } from "../src/domain/RatesService.js"
import { TransferService } from "../src/domain/TransferService.js"
import type { RateFetcher } from "../src/infra/cbu.js"
import { createTokenService } from "../src/infra/jwt.js"
import { createLogger } from "../src/infra/logger.js"
import { RatesRepository } from "../src/infra/RatesRepository.js"

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
  const accounts = new AccountService({ prisma, ...(now ? { now } : {}) })
  const transfers = new TransferService({ prisma, pepper: env.JWT_SECRET })
  const rates = new RatesService({ fetcher, store: new RatesRepository(prisma) })

  return {
    app: createApp({
      prisma,
      log,
      env,
      auth,
      accounts,
      tokens,
      transfers,
      rates,
      ...(now ? { now } : {}),
    }),
    logText: () => lines.join(""),
  }
}

/** A Prisma double for suites that must not touch a database. */
export const PRISMA_STUB = {
  $queryRaw: async () => [{ migration_name: "00000000000000_stub" }],
} as unknown as PrismaClient

/**
 * A phone number no other test in this run will produce.
 *
 * The counter is per file, because Vitest gives every test file a fresh module
 * registry — so the counter alone repeats across files and something has to
 * separate them. That separator used to be `Math.random()` over three digits,
 * directly under a comment explaining why randomness was the wrong tool. With
 * twenty test files in nine hundred buckets the birthday bound puts a
 * collision at roughly one run in five, and the symptom is a `400
 * REGISTRATION_FAILED` in whichever file drew the duplicate — which is P-17's
 * failure exactly, one layer up from where it was fixed.
 *
 * Now derived from the one thing that *is* unique per file: its own path.
 * Deterministic, so a run either collides always or never, and
 * `phone-uniqueness.test.ts` proves it never does for the files that exist. A
 * future file that hashes onto a taken bucket fails that test loudly instead
 * of making an unrelated suite flaky.
 *
 * Nine digits after `+998`: a leading `9` so the number looks like a mobile,
 * four for the file, four for the counter.
 *
 * Neither half keeps two *runs* apart, and that is deliberate rather than
 * missed: `global-setup.ts` truncates once per run, so yesterday's rows are
 * gone before the first phone is minted. A developer pointing at a database
 * that is not reset is the case P-17 closed by giving the suites their own.
 */
export function phoneBucketFor(testPath: string): string {
  // Split on either separator: the path is a POSIX one in CI and a Windows one
  // on a laptop, and a bucket that differed between them would put the two on
  // different numbers for the same file.
  const name = testPath.split(/[/\\]/).pop() ?? testPath

  // FNV-1a. Not for security — for a stable spread that does not depend on
  // the platform's string hashing, so CI and a laptop agree.
  let hash = 2166136261
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return String(1000 + ((hash >>> 0) % 9000))
}

let phoneCounter = 0
let phoneBucket: string | null = null

export function uniquePhone(): string {
  phoneBucket ??= phoneBucketFor(expect.getState().testPath ?? "unknown")
  phoneCounter += 1
  return `+9989${phoneBucket}${String(phoneCounter).padStart(4, "0")}`
}
