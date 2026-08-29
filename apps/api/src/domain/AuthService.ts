import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { AuthResponse, LoginRequest, PublicUser, RegisterRequest } from "@wallet/shared"
import {
  attemptSubject,
  dummyHash,
  generateRefreshToken,
  hashRefreshToken,
  hashSecret,
  pinSubject,
  registrationSubject,
  verifySecret,
} from "../infra/crypto.js"
import type { TokenService } from "../infra/jwt.js"
import {
  AccountLockedError,
  DomainError,
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
  /** Present so the row can answer "is a PIN set"; never leaves this module. */
  readonly pinHash: string | null
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
    /*
     * The boolean, never the hash. `respond()` parses through
     * `publicUserSchema`, which would strip an extra field — but the strip is
     * the second line of defence and this is the first: a projection that
     * carries a credential is one refactor away from publishing it.
     */
    pinSet: user.pinHash !== null,
  }
}

/** FR-9.5: three wrong PINs, then an hour with USSD transfers closed. */
const PIN_ATTEMPTS_BEFORE_LOCK = 3
const PIN_LOCK_MS = 60 * 60 * 1000

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
   * **Both outcomes do one durable write (P-13).** FR-1.5 made the *body* of a
   * refusal generic; it never made the work generic. A free number wrote a
   * user, an account and a refresh token, a taken one failed on the first
   * insert and rolled back, and the difference was readable: a ratio of 1.20
   * over four runs and a single sample classifiable about 80% of the time —
   * an oracle for exactly the question FR-1.5 exists to refuse.
   *
   * Equalising the *inserts* alone was tried first and measured, and it was not
   * enough: the gap narrowed but the classifier did not move, because the
   * dominant signal is the commit itself. Committing the discarded writes
   * instead dropped a single sample to 53-60%, near chance, which is what
   * identified durability rather than row count as the thing to match.
   *
   * So a refused registration now writes an `auth_attempt` and commits it. That
   * is not ballast: an unauthenticated endpoint refusing to create an account
   * is worth recording, and this is the table that records exactly that. It is
   * counted against `registrationSubject`, never `attemptSubject`, so it cannot
   * reach FR-2.3's backoff — otherwise anyone could lock a stranger out of
   * login by repeatedly attempting to register their number.
   *
   * The session is issued inside the transaction for the same reason: two
   * commits on the accepted path against one on the refused path would put the
   * asymmetry straight back.
   *
   * The pre-check does not decide uniqueness — the database still does, and the
   * catch below still handles the race in which two registrations both see a
   * number as free. It exists so the two outcomes can be given the same work.
   */
  async register(input: RegisterRequest): Promise<Session> {
    const passwordHash = await hashSecret(input.password)
    const subject = registrationSubject(input.phone, this.#pepper)

    const existing = await this.#prisma.user.findUnique({
      where: { phone: input.phone },
      select: { id: true },
    })

    if (existing) {
      /*
       * Deliberately without `userId`. The attempt was made by whoever sent the
       * request, who is not the account holder and may be attacking them;
       * attaching it to the victim would file somebody else's action under
       * their name.
       */
      await this.#prisma.authAttempt.create({ data: { subject, succeeded: false } })
      throw new RegistrationFailedError()
    }

    let session: Session
    try {
      session = await this.#prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone: input.phone,
            firstName: input.firstName,
            lastName: input.lastName,
            passwordHash,
          },
          select: { id: true, phone: true, firstName: true, lastName: true, pinHash: true },
        })

        // FR-1.4: one UZS account, balance 0. Inside the transaction, so a user
        // without an account cannot exist.
        await tx.account.create({
          data: { userId: created.id, currency: DEFAULT_CURRENCY, type: "USER", balance: 0n },
        })

        await tx.authAttempt.create({
          data: { userId: created.id, subject, succeeded: true },
        })

        return this.#issueSession(created, randomUUID(), tx)
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

    return session
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
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        passwordHash: true,
        pinHash: true,
      },
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
          user: {
            select: { id: true, phone: true, firstName: true, lastName: true, pinHash: true },
          },
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

  /**
   * FR-1.6: sets or replaces the USSD PIN, and only with the password.
   *
   * An access token proves someone is holding a live session. It does not
   * prove they are the account holder — a phone left unlocked on a table is a
   * live session — and the PIN gates a *second* channel that the token cannot
   * reach. Asking for the password is what stops a borrowed session from
   * granting USSD access the borrower never had.
   *
   * Changing it clears the lock. Somebody who can prove the password has
   * demonstrated more than three correct PIN digits would have, and leaving
   * them locked out of a PIN they have just chosen is punishing the recovery.
   */
  async setPin(userId: string, currentPassword: string, pin: string): Promise<void> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    })

    // A token for a user who no longer exists is a credential that should stop
    // working, not a 404.
    if (!user) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")

    if (!(await verifySecret(user.passwordHash, currentPassword))) {
      /*
       * `STEP_UP_FAILED`, not `AUTH_INVALID_CREDENTIALS`. The session is fine;
       * the confirmation was wrong. A 401 here would send the client off to
       * refresh a token that never expired and retry a request that would fail
       * again the same way.
       */
      throw new DomainError("STEP_UP_FAILED", "Password confirmation failed")
    }

    await this.#prisma.user.update({
      where: { id: userId },
      data: { pinHash: await hashSecret(pin), pinLockedUntil: null },
    })
  }

  /**
   * FR-9.5: three wrong PINs block USSD transfers for an hour.
   *
   * The block is stored rather than counted, because the counting would have
   * to survive a process restart and USSD sessions are stateless by nature —
   * every request arrives cold. `pinLockedUntil` is a single column that
   * answers "may this person transfer?" without reading a history.
   *
   * Consumed by the USSD adapter (B6). Written here because it is the same
   * credential the web sets, and two implementations of one rule is how the
   * two channels come to disagree about who is blocked.
   */
  async verifyPin(userId: string, pin: string): Promise<void> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { pinHash: true, pinLockedUntil: true },
    })

    if (!user) throw new DomainError("AUTH_TOKEN_EXPIRED", "Access token is not valid")
    if (!user.pinHash) throw new DomainError("PIN_NOT_SET", "No PIN has been set")

    const now = this.#now()
    if (user.pinLockedUntil && user.pinLockedUntil > now) {
      throw new DomainError("PIN_LOCKED", "PIN is locked")
    }

    if (await verifySecret(user.pinHash, pin)) {
      // A correct PIN clears the count, so three wrong attempts spread over a
      // month never add up to a block.
      await this.#prisma.authAttempt.create({
        data: { userId, subject: pinSubject(userId, this.#pepper), succeeded: true },
      })
      return
    }

    await this.#prisma.authAttempt.create({
      data: { userId, subject: pinSubject(userId, this.#pepper), succeeded: false },
    })

    const failures = await this.#consecutivePinFailures(userId)
    if (failures >= PIN_ATTEMPTS_BEFORE_LOCK) {
      await this.#prisma.user.update({
        where: { id: userId },
        data: { pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MS) },
      })
      throw new DomainError("PIN_LOCKED", "PIN is locked")
    }

    throw new DomainError("AUTH_INVALID_CREDENTIALS", "PIN is not correct")
  }

  async #consecutivePinFailures(userId: string): Promise<number> {
    const subject = pinSubject(userId, this.#pepper)

    const lastSuccess = await this.#prisma.authAttempt.findFirst({
      where: { subject, succeeded: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })

    return this.#prisma.authAttempt.count({
      where: {
        subject,
        succeeded: false,
        ...(lastSuccess ? { createdAt: { gt: lastSuccess.createdAt } } : {}),
      },
    })
  }

  async currentUser(userId: string): Promise<PublicUser | null> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, firstName: true, lastName: true, pinHash: true },
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
