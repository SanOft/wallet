import { withDb } from "./walletDb.js"

/**
 * FR-8.3: money-moving requests that could not be sent yet.
 *
 * The record's key *is* the `Idempotency-Key`, which is the whole reason this
 * is safe. A queued item may be sent once, twice, or never — the network drops
 * mid-flight and "did it arrive?" is genuinely unanswerable — and FR-4.4 makes
 * the server answer identically every time for one key. Storing the key with
 * the request rather than minting one per attempt is what turns "we do not
 * know" into "it does not matter".
 *
 * `attempts` is persisted for the same reason: the application can be closed
 * between retries, and a counter held in memory would restart the budget every
 * time someone reopened the app — which is how five attempts becomes fifty.
 */

export type OutboxStatus = "queued" | "failed"

export interface OutboxItem {
  /** The `Idempotency-Key`, and the primary key. One value, one meaning. */
  readonly key: string
  /** What to send. Only the demo top-up today; F4's transfer joins it. */
  readonly kind: "topup"
  readonly body: unknown
  readonly status: OutboxStatus
  /** How many times this has actually been sent, across app restarts. */
  readonly attempts: number
  readonly queuedAt: number
  /**
   * Why it will not be retried, in the user's language.
   *
   * Set only on a terminal outcome — a 4xx, or the attempt budget spent. A
   * queued item with no reason is still on its way; one with a reason has
   * stopped, and the difference has to be visible on screen.
   */
  readonly failReason?: string
}

const STORE = "outbox"

/**
 * The only place an idempotency key is created.
 *
 * `crypto.randomUUID` needs a secure context, which the app always has (§20.1
 * is HTTPS everywhere, and localhost counts). One factory rather than a call
 * at each site keeps the property that mattered when the key was minted inside
 * the request: every value is fresh, and no code path can reuse one by
 * accident. Reuse is now deliberate, and lives in exactly one place — the
 * retry.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/**
 * Who to tell when the queue changes.
 *
 * IndexedDB has no change events, so a screen reading it once at mount would
 * show an empty queue for as long as the tab stays open — the item is written
 * by a button and read by a list that never hears about it. That is not a
 * missing refresh: it is the interface telling somebody their request vanished.
 *
 * A set of callbacks rather than a Redux slice, because the store of record is
 * IndexedDB and mirroring it into another one would create two answers to the
 * same question. This publishes "it changed"; readers go and look.
 */
const watchers = new Set<() => void>()

export function watchOutbox(onChange: () => void): () => void {
  watchers.add(onChange)
  return () => {
    watchers.delete(onChange)
  }
}

function announce(): void {
  for (const watcher of watchers) watcher()
}

export async function enqueue(item: OutboxItem): Promise<void> {
  await withDb(
    "outbox:enqueue",
    async (db) => {
      await db.put(STORE, item, item.key)
    },
    undefined,
  )
  announce()
}

/**
 * Oldest first. §11.6 says queued items go "in order", and order is the only
 * thing that makes a sequence of transfers reproducible: two sends that swap
 * places can turn a pair that always fit into one that overdraws.
 */
export async function queuedItems(): Promise<OutboxItem[]> {
  const items = await withDb<unknown[]>("outbox:list", async (db) => db.getAll(STORE), [])
  return (items as OutboxItem[]).sort((a, b) => a.queuedAt - b.queuedAt)
}

export async function updateItem(item: OutboxItem): Promise<void> {
  await withDb(
    "outbox:update",
    async (db) => {
      await db.put(STORE, item, item.key)
    },
    undefined,
  )
  announce()
}

export async function removeItem(key: string): Promise<void> {
  await withDb(
    "outbox:remove",
    async (db) => {
      await db.delete(STORE, key)
    },
    undefined,
  )
  announce()
}

/**
 * Emptied on sign-out, like the read cache and for a sharper reason.
 *
 * A queued item is one person's money instruction carrying their idempotency
 * key. Sending it after they have signed out would use a session that is no
 * longer theirs — on a shared phone, quite possibly somebody else's — and
 * leaving it in place puts their pending transfer on the next person's screen.
 *
 * The cost is that a queued item is lost when its owner signs out before the
 * network returns. With only the demo top-up in the queue that costs nothing.
 * When F4 puts a real transfer here, someone signing out with unsent money
 * deserves to be asked first — recorded rather than built, because there is
 * nothing yet to ask about.
 */
export async function clearOutbox(): Promise<void> {
  await withDb(
    "outbox:clear",
    async (db) => {
      await db.clear(STORE)
    },
    undefined,
  )
  announce()
}
