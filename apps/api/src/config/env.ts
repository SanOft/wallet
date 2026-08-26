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

  /**
   * Neon connection string (§20.2). The scheme is checked here because a
   * typo like `postgres:/host` otherwise boots cleanly and fails at the first
   * query — which is the failure mode this whole module exists to prevent.
   */
  DATABASE_URL: z
    .string()
    .min(1, { error: "DATABASE_URL is required" })
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      error: "DATABASE_URL must be a postgresql:// connection string",
    }),

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

  /**
   * HS256 signing secret (§20.2). Rejected below 32 characters because HMAC-SHA256
   * takes a 256-bit key: a shorter secret is not "weaker but working", it is the
   * one thing standing between a forged token and an authenticated request, and
   * a deploy that quietly used `changeme` would look identical to a correct one.
   */
  JWT_SECRET: z.string().min(32, { error: "JWT_SECRET must be at least 32 characters (256 bits)" }),

  /** Cookie domain for the refresh token (§20.2). Omitted in development. */
  REFRESH_COOKIE_DOMAIN: z.string().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
})

/**
 * NOT YET CONSUMED — the CORS middleware lands at B5 (day 6). It is validated
 * here anyway so a deploy cannot reach that day without the value already set.
 *
 * NFR-1.8 forbids a `*` allowlist. An empty one is the other way to get it
 * wrong: in production it either blocks the PWA outright or invites someone to
 * "unbreak" it with a wildcard. Development is allowed to omit it.
 */
const configuredEnvSchema = envSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.CORS_ORIGINS.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["CORS_ORIGINS"],
      message: "CORS_ORIGINS must list at least one origin in production",
    })
  }
})

export type Env = z.infer<typeof envSchema>

/**
 * Throws with the offending variable names rather than a Zod dump, because the
 * reader of this message is someone whose deploy just failed.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = configuredEnvSchema.safeParse(source)
  if (parsed.success) return parsed.data

  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  throw new Error(`Invalid environment configuration:\n${problems}`)
}
