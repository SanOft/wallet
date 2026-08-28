import { jwtVerify, SignJWT } from "jose"
import type { Env } from "../config/env.js"

/**
 * Access tokens (FR-2.4, FR-2.5).
 *
 * HS256 is pinned in both directions and appears in exactly two places, both
 * here. FR-2.5 exists because the classic JWT break is a verifier that trusts
 * the token's own `alg` header: a forged `alg: none` is accepted as unsigned,
 * and `alg: HS256` against an RS256 public key turns a public value into a
 * signing secret. `jose` will not verify without an explicit algorithm list, so
 * the mistake is hard to make — but it is stated here so nobody widens it.
 *
 * One service signs and verifies its own tokens, so a symmetric algorithm is
 * right. With more than one verifier this becomes RS256 (§24, author's notes).
 */
const ALGORITHM = "HS256"

/** FR-2.4: fifteen minutes. Short, because there is no revocation list. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

const ISSUER = "wallet-api"
const AUDIENCE = "wallet-client"

export interface AccessTokenClaims {
  /** The user this token authenticates. */
  readonly userId: string
}

/**
 * What a verified token carries, as opposed to what signing needs.
 *
 * `issuedAt` is separate because a caller must never supply it — the point of
 * P-16's check is that the *server* decides when a token was minted, so a
 * client-supplied `iat` would be the revocation list letting the attacker
 * write to it.
 */
export interface VerifiedAccessToken extends AccessTokenClaims {
  /** Seconds since the epoch, as JWT `iat` is defined. */
  readonly issuedAt: number
}

export interface TokenService {
  readonly expiresInSeconds: number
  sign(claims: AccessTokenClaims): Promise<string>
  verify(token: string): Promise<VerifiedAccessToken | null>
}

export function createTokenService(env: Env): TokenService {
  const secret = new TextEncoder().encode(env.JWT_SECRET)

  return {
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,

    async sign({ userId }) {
      return new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(secret)
    },

    /**
     * Returns null rather than throwing. Every failure — expired, forged,
     * wrong algorithm, wrong audience — is the same answer to the caller, so
     * the adapter has one branch and no way to leak which one it was.
     */
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
        })
        if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null
        return { userId: payload.sub, issuedAt: payload.iat }
      } catch {
        return null
      }
    },
  }
}
