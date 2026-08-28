import { apiErrorSchema } from "@wallet/shared"

/**
 * What a failed sign-in should say, and nothing more.
 *
 * FR-2.2 is the constraint that shapes this: the message for an unknown number
 * and for a wrong password must be identical, or the form becomes the
 * enumeration oracle the server spends an argon2 hash to avoid. So the API's
 * distinct codes are deliberately collapsed here — the screen is not allowed to
 * be more informative than the protocol.
 */

export type AuthFailure =
  | { readonly kind: "credentials"; readonly message: string }
  | { readonly kind: "locked"; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: "offline"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string }

/** FR-2.2's exact wording: one sentence, whichever half was wrong. */
const CREDENTIALS = "Kirish amalga oshmadi. Raqam yoki parol noto'g'ri."

interface MaybeFetchError {
  readonly status?: unknown
  readonly data?: unknown
  readonly retryAfterSeconds?: unknown
}

export function interpret(error: unknown): AuthFailure {
  const candidate = error as MaybeFetchError | undefined
  const status = candidate?.status

  /*
   * `fetchBaseQuery` reports a network failure as a string status rather than
   * a number. Telling the user their password was wrong when the request never
   * left the device is the worst of both: they change a password that was
   * fine, and the real problem stays.
   */
  if (status === "FETCH_ERROR") {
    return { kind: "offline", message: "Aloqa yo'q. Ulanishni tekshirib, qayta urinib ko'ring." }
  }

  const parsed = apiErrorSchema.safeParse(candidate?.data)
  const code = parsed.success ? parsed.data.error.code : undefined

  if (code === "AUTH_LOCKED" || status === 429) {
    const seconds = candidate?.retryAfterSeconds
    return {
      kind: "locked",
      retryAfterSeconds: typeof seconds === "number" && seconds > 0 ? seconds : undefined,
    }
  }

  if (code === "AUTH_INVALID_CREDENTIALS" || status === 401) {
    return { kind: "credentials", message: CREDENTIALS }
  }

  // Everything else, including a 500. The screen says something happened and
  // does not speculate about what.
  return { kind: "unknown", message: "Nimadir noto'g'ri ketdi. Birozdan so'ng urinib ko'ring." }
}

/** "2 daqiqa 5 soniya" — §12.3 asks for the delay, not for a raw number. */
export function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} soniya`
  if (rest === 0) return `${minutes} daqiqa`
  return `${minutes} daqiqa ${rest} soniya`
}
