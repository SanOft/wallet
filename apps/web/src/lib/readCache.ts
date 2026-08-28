import { type DBSchema, type IDBPDatabase, openDB } from "idb"
import { reportError } from "./report.js"

/**
 * FR-8.2: the last successful read of each screen's data, kept across reloads.
 *
 * Not the service worker's job, and deliberately so. A worker that answered
 * `/api/accounts` from an HTTP cache would hand the application a response
 * indistinguishable from a fresh one — a real balance, rendered in the present
 * tense, with nothing on screen admitting its age. That is the failure F3 was
 * built to prevent. Here every record carries the moment it arrived, and the
 * interface says so.
 *
 * Three records, a few kilobytes. IndexedDB rather than `localStorage` because
 * `localStorage` is synchronous and blocks the main thread on a slow disk,
 * which on the low-end phones NFR-3 targets is exactly when it hurts.
 */

const DB_NAME = "wallet"
const DB_VERSION = 1
const STORE = "reads"

/** The screens whose reads are worth keeping. Strings, so they survive a bump. */
export type ReadCacheKey = "accounts" | "history:recent" | "rates"

export interface CachedRead {
  readonly data: unknown
  /** When the server answered — never when the row was written. */
  readonly fetchedAt: number
}

interface WalletDb extends DBSchema {
  [STORE]: { key: ReadCacheKey; value: CachedRead }
}

let database: Promise<IDBPDatabase<WalletDb>> | null = null

function db(): Promise<IDBPDatabase<WalletDb>> {
  // One connection per document, opened lazily: opening it at module load
  // would put an IndexedDB request on the critical path of a screen that may
  // never read from it.
  database ??= openDB<WalletDb>(DB_NAME, DB_VERSION, {
    upgrade(instance) {
      instance.createObjectStore(STORE)
    },
  })
  return database
}

/**
 * Every cache operation can fail, and none of them may take a screen with it.
 *
 * IndexedDB is unavailable in some private-browsing modes, disabled by policy
 * in others, and throws on a full disk. A wallet that refuses to show a
 * balance because it could not write a *cache* has inverted what a cache is
 * for. Reported rather than swallowed, because a build where nothing has been
 * cached for a month should be discoverable by someone other than the user.
 */
async function attempt<T>(scope: string, action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action()
  } catch (error) {
    reportError(`readCache:${scope}`, error)
    return fallback
  }
}

export async function readCached(key: ReadCacheKey): Promise<CachedRead | null> {
  return attempt<CachedRead | null>(
    `read:${key}`,
    // `?? null` on the awaited value, not on the call: `get` resolves to
    // `undefined` for a missing key, and the two absences mean the same thing
    // to every caller.
    async () => (await (await db()).get(STORE, key)) ?? null,
    null,
  )
}

export async function writeCached(key: ReadCacheKey, read: CachedRead): Promise<void> {
  await attempt(
    `write:${key}`,
    async () => {
      await (await db()).put(STORE, read, key)
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
  await attempt(
    "clear",
    async () => {
      await (await db()).clear(STORE)
    },
    undefined,
  )
}

/** Test seam: the connection outlives a test file otherwise. */
export function resetReadCacheConnection(): void {
  database = null
}
