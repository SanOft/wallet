import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino"
import type { Env } from "../config/env.js"

/**
 * NFR-5.2: passwords, tokens, PINs and full phone numbers are never logged.
 *
 * This is enforced by configuration rather than by discipline. A redaction list
 * that lives in the logger cannot be forgotten at a call site, which is the
 * failure mode a review checklist does not catch.
 */
const REDACTED_PATHS = [
  // Transport-level secrets
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',

  // Credentials, at the top level and one level down (request bodies)
  "password",
  "passwordHash",
  "pin",
  "pinHash",
  "*.password",
  "*.passwordHash",
  "*.pin",
  "*.pinHash",
  "req.body.password",
  "req.body.pin",

  // Session material
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "*.token",
  "*.tokenHash",
  "*.accessToken",
  "*.refreshToken",

  // Subscriber identity
  "phone",
  "phoneNumber",
  "*.phone",
  "*.phoneNumber",
  "req.body.phone",
  "req.query.phone",
]

/**
 * A phone number keeps its country prefix and last two digits, because a log
 * line that cannot identify *which* subscriber is useless for support, and one
 * that identifies them fully violates NFR-5.2. Everything else is removed
 * outright — there is no debugging value in a partial password.
 */
function censor(value: unknown, path: readonly string[]): string {
  const key = path[path.length - 1] ?? ""
  const isPhone = key === "phone" || key === "phoneNumber"

  if (isPhone && typeof value === "string" && value.length >= 6) {
    return `${value.slice(0, 4)}${"*".repeat(value.length - 6)}${value.slice(-2)}`
  }
  return "[redacted]"
}

/**
 * The destination is injectable so a test can assert on the actual bytes that
 * would be written. Redaction that is only checked by reading the config is not
 * checked at all.
 */
export function createLogger(env: Env, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor },
    // Emit `"level":"info"` rather than `"level":30`; a human reads these in the
    // Render log stream, not only a parser.
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "wallet-api" },
  } satisfies LoggerOptions

  return destination ? pino(options, destination) : pino(options)
}

export type { Logger }
