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
   * How many proxies in front of this process may be believed (P-11).
   *
   * Configuration rather than a constant, because the right value is a fact
   * about the deployment and not about the code. ADR-0009 put a second proxy
   * in front of the first, and the count that was compiled in had been chosen
   * for the chain before it — so correcting it used to mean a code change and
   * a deploy, for a number that is only knowable *from* the deployment.
   *
   * Express counts hops from the right, nearest this process, and one too few
   * does not fail loudly: `req.ip` silently becomes a proxy's own address, and
   * since every rate limit keys on it, every caller lands in one bucket. One
   * too many is the opposite failure — a forged `X-Forwarded-For`, believed.
   * `/health` reports the depth it actually observes so the value can be read
   * off a deployment rather than guessed at.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * The fixed time every registration takes, accepted or refused (P-13).
   *
   * FR-1.5 makes the *body* of a refusal generic so an attacker cannot walk a
   * number range and learn who banks here. It never made the *duration*
   * generic, and the duration was readable: a ratio of 1.20 and a single
   * sample classifiable about 80% of the time.
   *
   * Equalising the work was tried first and measured, twice. Giving the
   * refused path the same inserts moved the gap and not the classifier;
   * committing an `auth_attempt` so both outcomes commit once did not close it
   * either, because creating an account writes four rows against a refusal's
   * one. The residue is the intrinsic cost of the thing being refused, and no
   * arrangement of honest work removes it.
   *
   * So the response is held to a fixed budget instead. Measured before it was
   * chosen: an accepted registration runs 44 ms at its fastest, 73 ms at p90
   * and 124 ms at p99 on the development machine, so 250 ms clears the slow
   * tail with room. Configuration rather than a constant because a smaller
   * host has a slower tail, and a budget the work overruns is no budget at all
   * — `0` disables it, which the test suite uses so several hundred
   * registrations do not each wait a quarter second.
   */
  REGISTRATION_TIME_BUDGET_MS: z.coerce.number().int().min(0).max(5000).default(250),

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

  /**
   * Comma-separated allowlist. Never `*` (NFR-1.8) — and the rule is enforced
   * here rather than only stated.
   *
   * `*` was previously accepted. It happens to be inert, because no browser
   * sends `Origin: *`, but `null` is not: sandboxed iframes, `data:` documents
   * and some cross-origin redirects all send it, and the allowlist grants
   * `credentials: true`. One typo, or a deploy template rendering an unset
   * variable as the literal string `null`, was a credentialed grant to an
   * origin that cannot be attributed to anyone.
   *
   * Each entry is normalised through `URL`, so `https://Wallet.example.com` and
   * a trailing slash both become the origin a browser will actually send.
   * Without that, a mixed-case value in a hosting dashboard produces an
   * allowlist that silently never matches — the failure looks like a CORS bug
   * and gets "fixed" with a wildcard.
   */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .superRefine((origins, ctx) => {
      for (const origin of origins) {
        if (origin === "*" || origin.toLowerCase() === "null") {
          ctx.addIssue({
            code: "custom",
            message: `CORS_ORIGINS must name real origins; "${origin}" is not one (NFR-1.8)`,
          })
          continue
        }
        let parsed: URL
        try {
          parsed = new URL(origin)
        } catch {
          ctx.addIssue({
            code: "custom",
            message: `CORS_ORIGINS entry "${origin}" is not a valid origin`,
          })
          continue
        }
        if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
          ctx.addIssue({
            code: "custom",
            message: `CORS_ORIGINS entry "${origin}" must be https (localhost excepted)`,
          })
        }
      }
    })
    .transform((origins) =>
      origins.map((origin) => {
        try {
          return new URL(origin).origin
        } catch {
          return origin
        }
      }),
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

  /**
   * The shared secret a real USSD gateway presents on `/api/channels/ussd`
   * (§20.2, FR-9.1).
   *
   * Optional, and unset is the expected state: the MVP has no shortcode, only
   * the simulator (FR-9.6), which authenticates with the user's own session
   * instead. What matters is the direction of the default — an unset secret
   * makes the gateway route refuse every caller, because "not configured yet"
   * and "open to the internet" must not be the same deployment.
   *
   * Length-checked like `JWT_SECRET` for the same reason: it is a bearer
   * credential, and a short one is guessable rather than merely weak.
   */
  USSD_GATEWAY_SECRET: z
    .string()
    .min(32, { error: "USSD_GATEWAY_SECRET must be at least 32 characters" })
    .optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /**
   * Set by Render on every deploy — `health.ts` already reports it verbatim.
   * Declared here, optional, only so the superRefine below can read it from
   * the same `source` `loadEnv` was given rather than the process's own
   * environment; that is what lets a test exercise the boot check below
   * without mutating global state.
   */
  RENDER_GIT_COMMIT: z.string().optional(),
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

  /**
   * `RENDER_GIT_COMMIT` (F18) is set by the platform itself, never by a
   * template, so its presence is proof this process is a real hosted
   * deployment rather than a laptop. `NODE_ENV` defaults to "development",
   * and that default is what leaves cookies.ts sending a cookie without
   * `Secure` and this same superRefine skipping the CORS_ORIGINS check above
   * — both silently, on a host reachable from the internet.
   */
  if (env.RENDER_GIT_COMMIT !== undefined && env.NODE_ENV !== "production") {
    ctx.addIssue({
      code: "custom",
      path: ["NODE_ENV"],
      message: "NODE_ENV must be production on a hosted deployment",
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
