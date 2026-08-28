import type * as z from "zod"
import { reportError } from "./report.js"

/**
 * Checks a response against the contract before anything renders it.
 *
 * The server validates every response on the way out (`respond()`); this is
 * the same check on the way in, and it exists because the two are not the same
 * guarantee. A body can be replaced between them — a proxy's error page served
 * with a 200, a cached response from a previous deployment, an origin
 * misconfigured to answer `/api` with the SPA's own index.html — and none of
 * those are hypothetical on a phone behind a carrier's transparent proxy.
 *
 * TypeScript does not help here at all: `data` is typed as the contract
 * because we said so, and the first time it is not, a component reads a
 * property of `undefined` and the screen goes white. A white screen on a money
 * app is indistinguishable from a stolen account.
 *
 * Turning it into a query error instead means the screen says it could not
 * load the balance, which is the truth.
 */
export function parseResponse<T>(schema: z.ZodType<T>, scope: string) {
  return (response: unknown): T => {
    const parsed = schema.safeParse(response)

    if (!parsed.success) {
      /*
       * Reported before it is thrown. The screen turns this into "could not
       * load", which is right for the user and useless for anyone diagnosing
       * it: the interesting part is *which field* the server and client
       * disagree about, and that is discarded the moment this becomes a
       * generic query error.
       */
      reportError(`contract:${scope}`, parsed.error, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      })
      throw parsed.error
    }

    return parsed.data
  }
}
