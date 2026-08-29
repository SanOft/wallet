import { type DBSchema, type IDBPDatabase, openDB } from "idb"
import { reportError } from "./report.js"

/**
 * The one IndexedDB database, and the one place its version is decided.
 *
 * Two stores with different jobs — `reads` holds the last answer each screen
 * received (FR-8.2), `outbox` holds requests that have not been sent yet
 * (FR-8.3) — but one database, because a version bump has to see every store
 * at once. Opening the same database from two modules with two version numbers
 * is a `VersionError` on whichever loses the race, and it happens only on the
 * upgrade, which is to say only in front of real users.
 */

const DB_NAME = "wallet"

/** 1 was `reads` alone. 2 adds `outbox`. */
const DB_VERSION = 2

export interface CachedRead {
  readonly data: unknown
  /** When the server answered — never when the row was written. */
  readonly fetchedAt: number
}

export interface WalletDb extends DBSchema {
  reads: { key: string; value: CachedRead }
  outbox: { key: string; value: unknown }
}

let database: Promise<IDBPDatabase<WalletDb>> | null = null

function open(): Promise<IDBPDatabase<WalletDb>> {
  database ??= openDB<WalletDb>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      /*
       * Guarded by `oldVersion` rather than by `objectStoreNames.contains`.
       *
       * Both work today; only this one keeps working when a third store
       * arrives, because it states which version introduced what instead of
       * asking the database what it happens to hold. A migration that reads
       * the current shape to decide what to do cannot be reasoned about
       * backwards.
       */
      if (oldVersion < 1) db.createObjectStore("reads")
      if (oldVersion < 2) db.createObjectStore("outbox")
    },
  })
  return database
}

/**
 * Runs one operation, and never lets storage take a screen with it.
 *
 * IndexedDB is absent in some private-browsing modes, disabled by policy in
 * others, and throws on a full disk. A wallet that refuses to show a balance
 * because it could not write a cache has inverted what a cache is for — and
 * one that refuses to *send money* because it could not write an outbox record
 * would be worse still.
 *
 * Reported rather than swallowed: a build that has stored nothing for a month
 * should be discoverable by somebody other than the user.
 */
export async function withDb<T>(
  scope: string,
  action: (db: IDBPDatabase<WalletDb>) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await action(await open())
  } catch (error) {
    reportError(`idb:${scope}`, error)
    return fallback
  }
}

/** Test seam: the connection outlives a test file otherwise. */
export function resetWalletDb(): void {
  database = null
}
