import { createHash, createHmac, randomBytes } from "node:crypto"
import argon2 from "argon2"

/**
 * Password and PIN hashing (NFR-1.1, FR-1.3).
 *
 * The parameters are OWASP's minimum for Argon2id and are not tunable per call
 * site: a caller that could pass its own would eventually pass weaker ones.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS)
}

/**
 * Returns false rather than throwing on a malformed hash.
 *
 * That case is real, not hypothetical: the SYSTEM account's `passwordHash` is a
 * sentinel string rather than a PHC digest (§9.4), and a login attempt against
 * it must be an ordinary failure, not a 500 that tells the caller they found
 * something unusual.
 */
export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    /**
     * Returning false here without doing the work is a louder oracle than the
     * 500 this catch was written to avoid: the SYSTEM account is the only row
     * whose hash is a sentinel, so a bare `return false` made
     * `+998000000000` answer in 9ms against 34ms for every other number — a
     * 3.8x separation visible in a single request, identifying the treasury
     * (§9.4). Spend the time anyway.
     */
    await argon2.verify(await dummyHash(), plain).catch(() => false)
    return false
  }
}

/**
 * A pre-computed Argon2id digest of a value nobody knows, used to spend the
 * same CPU time on a login for a number that does not exist (FR-2.2, S-5).
 *
 * Returning early when the user is absent is the obvious implementation and it
 * leaks membership: an argon2 verify at m=19456 takes tens of milliseconds, so
 * "no such number" would answer visibly faster than "wrong password". The
 * digest is computed once at startup rather than per request, because doing it
 * per request would be a free denial-of-service lever.
 */
let dummyHashPromise: Promise<string> | undefined

export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashSecret(randomBytes(32).toString("hex"))
  return dummyHashPromise
}

/**
 * Called once at startup. Without it the *first* unknown-number login after a
 * cold start pays an extra full argon2 hash on top of the verify — a leak in
 * the opposite direction, and Render's free tier makes cold starts routine
 * (§20.3).
 */
export function warmDummyHash(): Promise<unknown> {
  return dummyHash()
}

/**
 * Refresh tokens are opaque random values, not JWTs (§21 Q-5): revocation needs
 * the database anyway, so a signed token would add risk without adding
 * anything. 256 bits of entropy, base64url so it survives a cookie unescaped.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Refresh tokens are stored as SHA-256 digests, never raw (§9.2), so a database
 * leak cannot hijack a session.
 *
 * SHA-256 rather than Argon2id on purpose: the input is 256 bits of our own
 * randomness, not a human-chosen password, so there is nothing to brute-force
 * and no reason to pay Argon2's cost on the hot refresh path.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}

/**
 * What FR-2.3's backoff counts against: a keyed digest of the number someone
 * tried to sign in as, whether or not it belongs to anyone.
 *
 * It has to cover unregistered numbers. Counting only registered ones means an
 * unknown number never backs off, so the fourth attempt answers `429` for a
 * customer and `401` for a stranger — a membership oracle that would undo
 * everything FR-2.2 and S-5 exist for, and a louder one than the timing leak
 * they were written against.
 *
 * Keyed rather than plain: `auth_attempts` records every attempt, including
 * numbers belonging to nobody, so the column becomes a list of numbers somebody
 * tried. A national number is nine digits — a bare SHA-256 of that space is
 * enumerable on a laptop, which would make the column the phone number with
 * extra steps.
 *
 * The prefix is domain separation. `JWT_SECRET` also signs access tokens, and
 * two uses of one key must not be able to produce each other's inputs. Rotating
 * the secret resets every counter, which is an acceptable — arguably desirable
 * — consequence.
 */
/**
 * The subject PIN attempts are counted against (FR-9.5).
 *
 * Keyed and domain-separated from `attemptSubject` by the prefix, so a wrong
 * PIN can never move the login backoff and a wrong password can never move the
 * PIN lock. They are different credentials guarding different channels, and
 * one counter for both would let an attacker on the cheap channel lock the
 * expensive one — or the reverse.
 *
 * Keyed on the user id rather than the phone: by the time a PIN is checked the
 * user is already identified, so there is no membership question to protect
 * and no reason to put a phone number through another hash.
 */
export function pinSubject(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`ussd-pin:v1:${userId}`).digest("base64url")
}

export function attemptSubject(phone: string, secret: string): string {
  return createHmac("sha256", secret).update(`auth-attempt:v1:${phone}`).digest("base64url")
}

/**
 * The subject a *registration* attempt is counted against (P-13).
 *
 * Separated from `attemptSubject` by its prefix for the reason the comment on
 * `pinSubject` already gives, and here the danger is sharper than a shared
 * counter: registration is unauthenticated and anyone may name any number, so
 * a shared subject would let an attacker lock a stranger out of *login* by
 * repeatedly attempting to register their number. The recorded attempt exists
 * to make a refused registration cost a durable write, and to be an audit
 * trail; it must never reach FR-2.3's backoff.
 */
export function registrationSubject(phone: string, secret: string): string {
  return createHmac("sha256", secret).update(`registration:v1:${phone}`).digest("base64url")
}
