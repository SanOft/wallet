import * as z from "zod"

/**
 * Configuration is parsed once, at boot, and the process refuses to start if
 * anything is missing or malformed (NFR-1.9, spec §20.2).
 *
 * The alternative — reading process.env at the point of use — moves the failure
 * from startup to the first request that happens to need the variable, which in
 * practice means it is discovered in production by a user.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /** Neon connection string (§20.2). */
  DATABASE_URL: z.string().min(1, { error: "DATABASE_URL is required" }),

  /** Comma-separated allowlist. Never `*` (NFR-1.8). */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
})

export type Env = z.infer<typeof envSchema>

/**
 * Throws with the offending variable names rather than a Zod dump, because the
 * reader of this message is someone whose deploy just failed.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (parsed.success) return parsed.data

  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  throw new Error(`Invalid environment configuration:\n${problems}`)
}
