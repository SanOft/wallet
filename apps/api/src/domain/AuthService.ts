import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { AuthResponse, LoginRequest, PublicUser, RegisterRequest } from "@wallet/shared"
import {
  dummyHash,
  generateRefreshToken,
  hashRefreshToken,
  hashSecret,
  verifySecret,
} from "../infra/crypto.js"
import type { TokenService } from "../infra/jwt.js"
import {
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
  /** Injected so tests can freeze it; the client clock is never trusted (D-10). */
  readonly now?: () => Date
}

interface UserRow {
  readonly id: string
  readonly phone: string
  readonly firstName: string
  readonly lastName: string
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
  }
}

export class AuthService {
  readonly #prisma: PrismaClient
  readonly #tokens: TokenService
  readonly #now: () => Date

  constructor({ prisma, tokens, now = () => new Date() }: AuthServiceDependencies) {
    this.#prisma = prisma
    this.#tokens = tokens
    this.#now = now
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
    } catch {
      // FR-1.5: every rejection looks the same from outside, whether the number
      // was taken or the write failed for another reason.
      throw new RegistrationFailedError()
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
    const user = await this.#prisma.user.findUnique({
      where: { phone: input.phone },
      select: { id: true, phone: true, firstName: true, lastName: true, passwordHash: true },
    })

    const hash = user?.passwordHash ?? (await dummyHash())
    const passwordMatches = await verifySecret(hash, input.password)

    if (!user || !passwordMatches) {
      // Recorded only when we know who to record it against; an attempt on a
      // number that does not exist has no row to hang off (§9.2).
      if (user) {
        await this.#prisma.authAttempt.create({ data: { userId: user.id, succeeded: false } })
      }
      throw new InvalidCredentialsError()
    }

    await this.#prisma.authAttempt.create({ data: { userId: user.id, succeeded: true } })

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

    const stored = await this.#prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        familyId: true,
        usedAt: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { id: true, phone: true, firstName: true, lastName: true } },
      },
    })

    if (!stored) throw new RefreshTokenInvalidError()

    if (stored.usedAt !== null) {
      await this.#revokeFamily(stored.familyId, now)
      throw new RefreshTokenReusedError()
    }

    if (stored.revokedAt !== null || stored.expiresAt <= now) {
      throw new RefreshTokenInvalidError()
    }

    // Rotation and issuance are one transaction: a crash between them would
    // either strand the family or leave two live tokens in it.
    return this.#prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({ where: { id: stored.id }, data: { usedAt: now } })
      return this.#issueSession(stored.user, stored.familyId, tx)
    })
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

  async #revokeFamily(familyId: string, at: Date): Promise<void> {
    // One UPDATE over a set rather than a row: every live token in the family
    // dies in a single statement, so there is no window where some survive.
    await this.#prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
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
