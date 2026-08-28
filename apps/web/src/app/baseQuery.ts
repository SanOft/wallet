import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  FetchBaseQueryMeta,
} from "@reduxjs/toolkit/query"
import { fetchBaseQuery } from "@reduxjs/toolkit/query"
import { credentialsReceived, signedOut } from "../features/auth/authSlice.js"
import type { RootState } from "./store.js"

/**
 * §11.3's refresh flow: one refresh at a time, and the original request
 * retried once it lands.
 */

/**
 * `/api` on whatever origin the document was served from (ADR-0009).
 *
 * Resolved against `location` rather than left relative, because RTK Query
 * hands the path to `new Request(...)` and Node's implementation — the one
 * Vitest provides — rejects a relative URL outright. In a browser the result is
 * identical to `/api`: same origin, same cookie.
 *
 * It is deliberately *not* the API's own hostname. The refresh cookie is
 * `SameSite=Strict`, so a cross-site request would silently not carry it, and
 * that failure appears only after deployment (P-14, closed by ADR-0009).
 */
const API_BASE = new URL("/api", globalThis.location?.href ?? "http://localhost").toString()

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE,
  /** Without this the cookie is not sent even same-origin on some paths. */
  credentials: "include",
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.accessToken
    if (token) headers.set("authorization", `Bearer ${token}`)
    return headers
  },
})

/**
 * Endpoints where a 401 is an answer, not an expiry.
 *
 * A wrong password returns 401 (`AUTH_INVALID`, §12.3). Without this list the
 * client would respond to a failed sign-in by trying to refresh — burning a
 * request, and, if a stale cookie happened to still be valid, signing the user
 * in as somebody they did not just authenticate as.
 */
const NEVER_REAUTH = ["/auth/login", "/auth/register", "/auth/refresh"]

function targets(args: string | FetchArgs, path: string): boolean {
  const url = typeof args === "string" ? args : args.url
  return url.startsWith(path)
}

/**
 * The mutex §11.3 asks for, as a shared promise.
 *
 * Every request that meets a 401 while a refresh is already running awaits the
 * same promise instead of starting its own. Three parallel 401s therefore
 * produce one `POST /auth/refresh`, which matters for more than efficiency:
 * refresh *rotates* the token (FR-2.6), so a second concurrent call would
 * present a token the first has already spent and be read as reuse — the
 * client would trigger the theft detection against itself and revoke the whole
 * family.
 *
 * A shared promise rather than a mutex library: this is the entire semantics,
 * and the parallel-401 test asserts the request count rather than trusting it.
 */
let refreshInFlight: Promise<boolean> | null = null

/**
 * The meta type is declared, not left to default.
 *
 * Without it `meta` is `{}` everywhere downstream, and `transformErrorResponse`
 * cannot reach the response headers — which is where §12.3 puts `Retry-After`,
 * the number the lockout screen counts down.
 */
export const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  // RTK's own default for per-endpoint extraOptions. `{}` is the banned
  // "anything non-nullish" type everywhere else, and is correct here for one
  // reason: it is the exact type RTK declares, and narrowing it — to `object`
  // or `Record<string, never>` — makes `extraOptions` mandatory on every
  // endpoint that never uses it.
  // biome-ignore lint/complexity/noBannedTypes: must match RTK's own default
  {},
  FetchBaseQueryMeta
> = async (args, api, extraOptions) => {
  const first = await rawBaseQuery(args, api, extraOptions)

  if (first.error?.status !== 401) return first
  if (NEVER_REAUTH.some((path) => targets(args, path))) return first

  const refreshed = await refreshOnce(api, extraOptions)
  if (!refreshed) {
    // The refresh failed: expired, revoked, or reuse detected. All three mean
    // the client holds nothing worth keeping.
    api.dispatch(signedOut())
    return first
  }

  return rawBaseQuery(args, api, extraOptions)
}

function refreshOnce(
  api: Parameters<typeof rawBaseQuery>[1],
  extraOptions: Parameters<typeof rawBaseQuery>[2],
): Promise<boolean> {
  refreshInFlight ??= performRefresh(api, extraOptions).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function performRefresh(
  api: Parameters<typeof rawBaseQuery>[1],
  extraOptions: Parameters<typeof rawBaseQuery>[2],
): Promise<boolean> {
  const result = await rawBaseQuery(
    // No body: the refresh token is in the cookie and never touches JavaScript.
    { url: "/auth/refresh", method: "POST" },
    api,
    extraOptions,
  )

  const token = (result.data as { accessToken?: unknown } | undefined)?.accessToken
  if (typeof token !== "string") return false

  api.dispatch(credentialsReceived({ accessToken: token }))
  return true
}

/** Test seam: module state outlives a test file otherwise. */
export function resetRefreshState(): void {
  refreshInFlight = null
}
