import { type CachedRead, withDb } from "./walletDb.js"

/**
 * FR-8.2: the last successful read of each screen's data, kept across reloads.
 *
 * Not the service worker's job, and deliberately so. A worker that answered
 * `/api/accounts` from an HTTP cache would hand the application a response
 * indistinguishable from a fresh one — a real balance, rendered in the present
 * tense, with nothing on screen admitting its age. That is the failure F3 was
 * built to prevent. Here every record carries the moment it arrived, and the
 * interface says so.
 */

/** The screens whose reads are worth keeping. Strings, so they survive a bump. */
export type ReadCacheKey = "accounts" | "history:recent" | "rates"

export type { CachedRead }

export async function readCached(key: ReadCacheKey): Promise<CachedRead | null> {
  return withDb<CachedRead | null>(
    `read:${key}`,
    // `?? null` on the awaited value: `get` resolves to `undefined` for a
    // missing key, and the two absences mean the same thing to every caller.
    async (db) => (await db.get("reads", key)) ?? null,
    null,
  )
}

export async function writeCached(key: ReadCacheKey, read: CachedRead): Promise<void> {
  await withDb(
    `write:${key}`,
    async (db) => {
      await db.put("reads", read, key)
    },
    undefined,
  )
}

/**
 * Emptied on sign-out, and this is a security requirement rather than tidiness.
 *
 * The records are one person's balance and one person's transfers. A shared
 * phone — which in this market is the common case, not the edge case — would
 * otherwise show the previous user's money to the next one, on a screen that
 * correctly labels it as theirs.
 *
 * Wired to the `signedOut` action by a listener rather than called from the
 * three places that dispatch it: a cleanup that has to be remembered in three
 * places is a cleanup that will be missed in the fourth.
 */
export async function clearReadCache(): Promise<void> {
  await withDb(
    "clear",
    async (db) => {
      await db.clear("reads")
    },
    undefined,
  )
}

export { resetWalletDb as resetReadCacheConnection } from "./walletDb.js"
