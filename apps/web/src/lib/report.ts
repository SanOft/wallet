/**
 * The one place a swallowed failure is allowed to go.
 *
 * Several things in this application catch an error and carry on, and each of
 * them is defensible on its own: a theme preference that will not persist, a
 * rates widget that hides itself, a cache that could not be written. What is
 * not defensible is the sum of them — a build where six different faults all
 * look like "the app is fine", and the only way to learn otherwise is for a
 * user to describe a screen nobody can reproduce.
 *
 * So every catch that keeps going reports here first. Today that is the
 * console, with a prefix that makes the set greppable; when there is a
 * telemetry sink it replaces this function body and nothing else changes.
 *
 * Deliberately not a thrown error and deliberately not user-facing: the caller
 * has already decided the user does not need to act. This is for whoever has
 * to explain it later.
 */

const PREFIX = "[wallet]"

export function reportError(scope: string, error: unknown, extra?: Record<string, unknown>): void {
  // Never let reporting be the thing that breaks the page. A console that
  // throws is absurd, and it is exactly the kind of absurdity that turns a
  // handled failure into a white screen.
  try {
    console.error(`${PREFIX} ${scope}`, error, extra ?? {})
  } catch {
    // Nothing left to try. Rethrowing here would defeat the entire purpose.
  }
}

/**
 * Reports only what the interface has not already explained.
 *
 * "Nothing fails silently" and "report everything" are not the same rule, and
 * the second one destroys the first. A wrong password is the ordinary path
 * through a login form; logging it makes the console a place where real faults
 * scroll past between hundreds of expected ones, and a console nobody reads is
 * the same as no reporting at all.
 *
 * So the caller names the outcomes it already handles, and anything else — a
 * 500, a schema failure, an error shape nobody anticipated — is reported.
 */
export function reportUnexpected(scope: string, error: unknown, handled: readonly string[]): void {
  const code = (error as { data?: { error?: { code?: string } } } | undefined)?.data?.error?.code

  if (typeof code === "string" && handled.includes(code)) return
  reportError(scope, error)
}
