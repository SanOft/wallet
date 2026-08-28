import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { AuthResponse, LoginRequest, PublicUser, RegisterRequest } from "@wallet/shared"
import {
  attemptSubject,
  dummyHash,
  generateRefreshToken,
  hashRefreshToken,
  hashSecret,
  verifySecret,
} from "../infra/crypto.js"
import type { TokenService } from "../infra/jwt.js"
import {
  AccountLockedError,
  InvalidCredentialsError,
  RefreshTokenInvalidError,
  RefreshTokenReusedError,
  RegistrationFailedError,
} from "./errors.js"

/**
 * Authentication (FR-1, FR-2).
 *
 * Channel-agnostic by §8.3: it takes plain objects, returns plain objects, and
 * knows nothing about cookies, headers or status codes. The adapter decides
 * that a refresh token belongs in an httpOnly cookie; this file only says that
 * one exists.
 */

/** FR-2.4: thirty days. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The default currency a new account is opened in (FR-1.4). */
const DEFAULT_CURRENCY = "UZS"

export interface Session {
  readonly auth: AuthResponse
  /** Raw value; the adapter puts it in the cookie. Never stored (§9.2). */
  readonly refreshToken: string
}

export interface AuthServiceDependencies {
  readonly prisma: PrismaClient
  readonly tokens: TokenService
  /**
   * Keys the digest FR-2.3's backoff counts against. `JWT_SECRET` is passed
   * here rather than a second variable — `attemptSubject` domain-separates the
   * two uses — so a deploy cannot end up with a signing key but no pepper.
   */
  readonly pepper: string
  /** Injected so tests can freeze it; the client clock is never trusted (D-10). */
  readonly now?: () => Date
}

interface UserRow {
  readonly id: string
  readonly phone: string
  readonly firstName: string
  readonly lastName: string
}

/** Prisma signals a unique-constraint violation with P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  )
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
  }
}

/** FR-2.3: three failures are free; the fourth waits 1s, the fifth 2s. */
const BACKOFF_FREE_ATTEMPTS = 3

/** FR-2.3 caps the wait at fifteen minutes. */
const BACKOFF_CAP_SECONDS = 15 * 60

/**
 * 2^(n-3) reaches the cap at thirteen failures, so counting past that changes
 * nothing — and an unbounded count would let an attacker grow the query.
 */
const BACKOFF_MAX_COUNTED = BACKOFF_FREE_ATTEMPTS + 13

export class AuthService {
  readonly #prisma: PrismaClient
  readonly #tokens: TokenService
  readonly #now: () => Date
  readonly #pepper: string

  constructor({ prisma, tokens, pepper, now = () => new Date() }: AuthServiceDependencies) {
    this.#prisma = prisma
    this.#tokens = tokens
    this.#pepper = pepper
    this.#now = now
  }

  /**
   * FR-2.3: after three consecutive failures, 1s, then 2s, 4s, and so on,
   * capped at fifteen minutes.
   *
   * Counted against a keyed digest of the number rather than against the user,
   * so an unregistered number backs off on exactly the same schedule. Counted
   * as *consecutive* failures since the last success, so signing in clears the
   * penalty — a window-based count would keep punishing someone who has
   * already proved who they are.
   */
  async #backoffSeconds(subject: string): Promise<number> {
    const lastSuccess = await this.#prisma.authAttempt.findFirst({
      where: { subject, succeeded: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })

    const failures = await this.#prisma.authAttempt.findMany({
      where: {
        subject,
        succeeded: false,
        ...(lastSuccess ? { createdAt: { gt: lastSuccess.createdAt } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
      // Beyond the cap the delay stops growing, so there is nothing to learn
      // from counting further.
      take: BACKOFF_MAX_COUNTED,
    })

    if (failures.length < BACKOFF_FREE_ATTEMPTS) return 0

    const delay = Math.min(2 ** (failures.length - BACKOFF_FREE_ATTEMPTS), BACKOFF_CAP_SECONDS)
    const newest = failures[0]?.createdAt
    if (!newest) return 0

    const elapsed = (this.#now().getTime() - newest.getTime()) / 1000
    return Math.max(0, Math.ceil(delay - elapsed))
  }

  /**
   * FR-1: a user and their UZS account are created together or not at all.
   *
   * The uniqueness of `phone` is enforced by the database, and the failure is
   * caught rather than pre-checked: a `SELECT` then `INSERT` has a window in
   * which two concurrent registrations both see the number as free.
   */
  async register(input: RegisterRequest): Promise<Session> {
    const passwordHash = await hashSecret(input.password)

    let user: UserRow
    try {
      user = await this.#prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone: input.phone,
            firstName: input.firstName,
            lastName: input.lastName,
            passwordHash,
          },
          select: { id: true, phone: true, firstName: true, lastName: true },
        })

        // FR-1.4: one UZS account, balance 0. Inside the transaction, so a user
        // without an account cannot exist.
        await tx.account.create({
          data: { userId: created.id, currency: DEFAULT_CURRENCY, type: "USER", balance: 0n },
        })

        return created
      })
    } catch (error) {
      // FR-1.5 covers a *taken number*: that rejection is deliberately generic
      // so an attacker cannot walk a range and learn who banks here.
      //
      // It does not cover a database outage. Reporting one as 400 "check your
      // details" tells the user their input is wrong, marks the failure
      // non-retryable under §12.3, and leaves no error-level log line — the
      // same retryability inversion the error handler exists to prevent, in
      // the opposite direction.
      if (isUniqueViolation(error)) throw new RegistrationFailedError()
      throw error
    }

    return this.#issueSession(user, randomUUID())
  }

  /**
   * FR-2.1, FR-2.2, S-5.
   *
   * The work done is identical whether or not the number exists: when it does
   * not, the password is verified against a throwaway digest so the response
   * time carries no information. Returning early here is the natural way to
   * write this and it is exactly the leak S-5 tests for.
   */
  async login(input: LoginRequest): Promise<Session> {
    const subject = attemptSubject(input.phone, this.#pepper)

    /*
     * Checked before the password, and before the user is even looked up.
     *
     * Verifying first would spend an argon2 hash on every request an attacker
     * sends, which turns the defence into the denial of service it exists to
     * prevent. Refusing early also keeps the locked response identical for
     * registered and unregistered numbers — both are fast, both say the same
     * thing.
     */
    const waitFor = await this.#backoffSeconds(subject)
    if (waitFor > 0) throw new AccountLockedError(waitFor)

    const user = await this.#prisma.user.findUnique({
      where: { phone: input.phone },
      select: { id: true, phone: true, firstName: true, lastName: true, passwordHash: true },
    })

    const hash = user?.passwordHash ?? (await dummyHash())
    const passwordMatches = await verifySecret(hash, input.password)

    // Written unconditionally, with a null subject when the number is unknown
    // (§11.2 draws it that way). Recording only the attempts that match a user
    // made a registered number cost one extra INSERT, which was measurable from
    // outside as ~6ms and classified numbers at 80% accuracy.
    await this.#prisma.authAttempt.create({
      data: {
        userId: user?.id ?? null,
        subject,
        succeeded: Boolean(user) && passwordMatches,
      },
    })

    if (!user || !passwordMatches) throw new InvalidCredentialsError()

    // A fresh family: this is a new device as far as we can tell (§9.2).
    return this.#issueSession(user, randomUUID())
  }

  /**
   * FR-2.6 rotation and FR-2.7 reuse detection, S-4.
   *
   * A token that has already been exchanged coming back means one of two
   * things: the client replayed it, or someone else has a copy. We cannot tell
   * which, so the safe reading is the hostile one and the whole family dies.
   */
  async refresh(rawToken: string): Promise<Session> {
    const tokenHash = hashRefreshToken(rawToken)
    const now = this.#now()

    /**
     * The claim has to be atomic. Reading `usedAt` and then writing it is a
     * lost update: two replays of the same stolen token that arrive together
     * both read `null`, both write, and both get a working session while reuse
     * detection never fires. Sequential replay is the interleaving that is easy
     * to imagine and the one an attacker has no reason to choose.
     *
     * `updateMany` with `usedAt: null` in the predicate makes the database the
     * arbiter: under READ COMMITTED the second writer blocks, re-evaluates the
     * predicate against the committed row, and matches nothing.
     */
    const outcome = await this.#prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          familyId: true,
          user: { select: { id: true, phone: true, firstName: true, lastName: true } },
        },
      })

      if (!stored) return { kind: "invalid" as const }

      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      })

      if (claimed.count === 0) {
        // The claim lost. Re-read to learn why: an already-used token is a
        // reuse and costs the family; a revoked or expired one is merely dead.
        const current = await tx.refreshToken.findUnique({
          where: { id: stored.id },
          select: { usedAt: true },
        })
        return current?.usedAt
          ? { kind: "reused" as const, familyId: stored.familyId }
          : { kind: "invalid" as const }
      }

      return {
        kind: "ok" as const,
        session: await this.#issueSession(stored.user, stored.familyId, tx),
      }
    })

    if (outcome.kind === "reused") {
      // Deliberately after the transaction commits. Revoking inside it and then
      // throwing would roll the revocation back, which is the failure mode that
      // makes a "we handled it" comment quietly false.
      await this.#revokeFamily(outcome.familyId, now)
      await this.#invalidateAccessTokens(outcome.familyId, now)
      throw new RefreshTokenReusedError()
    }

    if (outcome.kind === "invalid") throw new RefreshTokenInvalidError()

    return outcome.session
  }

  /** Revokes the family this token belongs to, signing that device out. */
  async logout(rawToken: string): Promise<void> {
    const stored = await this.#prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
      select: { familyId: true },
    })
    // A logout for an unknown token is not an error: the caller wanted to be
    // signed out and they are.
    if (stored) await this.#revokeFamily(stored.familyId, this.#now())
  }

  async currentUser(userId: string): Promise<PublicUser | null> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, firstName: true, lastName: true },
    })
    return user ? toPublicUser(user) : null
  }

  /** Ends one device's chain. Called by logout and by reuse detection alike. */
  async #revokeFamily(familyId: string, at: Date): Promise<void> {
    // One UPDATE over a set rather than a row: every live token in the family
    // dies in a single statement, so there is no window where some survive.
    await this.#prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    })
  }

  /**
   * Ends every *access* token the user holds, everywhere (P-16).
   *
   * Separate from revoking a family, and called only when reuse is detected.
   * A JWT is self-contained, so revoking the family stops the thief refreshing
   * but leaves the token they already hold working until it expires — FR-2.6
   * bounds that at fifteen minutes, and `requireCurrentSession` closes it on
   * the money routes.
   *
   * Not folded into `#revokeFamily`, which was the first thing I tried: a
   * family is one device, this column is every device, so an ordinary logout
   * would have signed the user out of their phone as well as their laptop. A
   * test caught it.
   *
   * Scoped through the family because the reuse path knows which family was
   * replayed, and every family belongs to exactly one user.
   */
  async #invalidateAccessTokens(familyId: string, at: Date): Promise<void> {
    await this.#prisma.user.updateMany({
      where: { refreshTokens: { some: { familyId } } },
      data: { tokensValidAfter: at },
    })
  }

  async #issueSession(
    user: UserRow,
    familyId: string,
    tx: Pick<PrismaClient, "refreshToken"> = this.#prisma,
  ): Promise<Session> {
    const refreshToken = generateRefreshToken()
    const now = this.#now()

    await tx.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        // §9.2: the digest, never the value. A database leak cannot hijack a
        // session because what is stored cannot be presented.
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      },
    })

    const accessToken = await this.#tokens.sign({ userId: user.id })

    return {
      auth: {
        accessToken,
        expiresIn: this.#tokens.expiresInSeconds,
        user: toPublicUser(user),
      },
      refreshToken,
    }
  }
}
