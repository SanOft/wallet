import { useCallback, useEffect, useRef, useState } from "react"
import { walletApi } from "../../app/api.js"
import { useAppDispatch } from "../../app/hooks.js"
import { useOnline } from "../../lib/freshness.js"
import {
  type OutboxItem,
  queuedItems,
  removeItem,
  updateItem,
  watchOutbox,
} from "../../lib/outbox.js"
import { accountsApi } from "../accounts/api.js"
import { transferApi } from "../transfer/api.js"
import { classify, MAX_ATTEMPTS, waitBefore } from "./policy.js"

/**
 * §11.6's drain: queued requests, sent in order, when there is a network.
 *
 * One at a time and oldest first. Order is not decoration — two transfers that
 * swap places can turn a pair that always fit into one that overdraws — and
 * sending them concurrently would also let two attempts of the *same* item
 * overlap after a slow first try.
 *
 * The idempotency key travels with the record rather than being minted per
 * attempt, which is what makes the ambiguous case safe: a request that timed
 * out may or may not have arrived, and resending the same key can only ever
 * produce the answer the first one produced (FR-4.4).
 *
 * Retries live here rather than in `baseQuery` because they must outlive the
 * component that started them. Someone who queues a top-up and walks to the
 * home screen has not cancelled anything.
 */

export interface OutboxState {
  readonly queued: readonly OutboxItem[]
  /** Sends whatever is waiting, now. Exposed for a retry control and for tests. */
  readonly drain: () => Promise<void>
}

/**
 * Sends one queued item through the same path every other request takes.
 *
 * The first version of this called `fetch` directly and set three headers by
 * hand — and forgot the fourth. Every queued send went out unauthenticated,
 * came back 401, and was filed as permanently rejected: an outbox that could
 * never succeed, hidden behind a green test suite because the double did not
 * check authorisation. A browser found it in one click.
 *
 * Dispatching the endpoint instead means the access token, the single-flight
 * refresh and the rotation handling in `baseQueryWithReauth` all apply here
 * too. A queued request is not a different kind of request; it is the same one,
 * later.
 */
async function send(
  dispatch: ReturnType<typeof useAppDispatch>,
  item: OutboxItem,
): Promise<{ status: number | null; code: string | null }> {
  /*
   * The endpoint follows the record's kind. A queued transfer carries the
   * recipient and the amount it was created with — and deliberately no
   * password: a credential must never be written to IndexedDB, which is why a
   * transfer large enough to need one is refused at the confirmation screen
   * rather than queued to fail later.
   */
  const result =
    item.kind === "transfer"
      ? await dispatch(
          transferApi.endpoints.createTransfer.initiate({
            ...(item.body as { phone: string; amount: string }),
            idempotencyKey: item.key,
          }),
        )
      : await dispatch(accountsApi.endpoints.topUp.initiate({ idempotencyKey: item.key }))

  if (!("error" in result) || result.error === undefined) return { status: 200, code: null }

  const error = result.error as {
    status?: number | string
    data?: { error?: { code?: string } }
  }

  /*
   * RTK Query reports a transport failure as a string — `FETCH_ERROR`,
   * `TIMEOUT_ERROR` — and a server one as a number. Everything that is not a
   * number is "nobody answered", which is the retryable case and the reason
   * this queue exists.
   */
  const status = typeof error.status === "number" ? error.status : null
  return { status, code: error.data?.error?.code ?? null }
}

export function useOutbox(): OutboxState {
  const dispatch = useAppDispatch()
  const online = useOnline()
  const [queued, setQueued] = useState<readonly OutboxItem[]>([])

  /*
   * A retry is scheduled by one render and has to run the *current* drain, not
   * the closure that scheduled it. The ref is also what makes cleanup
   * possible: a timer left running after unmount would set state on a
   * component that no longer exists, and in a test it fires inside the next
   * test instead.
   */
  const drainRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const items = await queuedItems()
    if (mounted.current) setQueued(items)
  }, [])

  const drain = useCallback(async () => {
    const pending = (await queuedItems()).filter((item) => item.status === "queued")

    for (const item of pending) {
      const { status, code } = await send(dispatch, item)
      const outcome = classify(status, code)

      if (outcome.kind === "sent") {
        await removeItem(item.key)
        /*
         * The screens refetch rather than being handed the response. What the
         * server holds now is the only thing worth showing, and a client that
         * patched its own cache from a queued write would be asserting a
         * balance nobody confirmed.
         */
        dispatch(walletApi.util.invalidateTags(["Accounts", "History"]))
        continue
      }

      const attempts = item.attempts + 1

      if (outcome.kind === "rejected") {
        // Understood and refused. FR-8.4: never again.
        await updateItem({ ...item, attempts, status: "failed", failReason: code ?? "unknown" })
        continue
      }

      const wait = attempts >= MAX_ATTEMPTS ? null : waitBefore(attempts)

      if (wait === null) {
        // Five attempts spent. Stopping is the point: a queue that retries
        // forever is a background process nobody can see or stop.
        await updateItem({ ...item, attempts, status: "failed", failReason: "exhausted" })
        continue
      }

      await updateItem({ ...item, attempts })

      /*
       * Stops the whole drain rather than moving to the next item, because
       * order is the promise (§11.6) and skipping past something unsent breaks
       * it. The timer, or the next `online` event, starts again from the front.
       */
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        void drainRef.current()
      }, wait)
      timers.current.add(timer)
      break
    }

    await refresh()
  }, [dispatch, refresh])

  drainRef.current = drain

  useEffect(() => {
    mounted.current = true
    const scheduled = timers.current

    return () => {
      mounted.current = false
      for (const timer of scheduled) clearTimeout(timer)
      scheduled.clear()
    }
  }, [])

  useEffect(() => {
    void refresh()
    // IndexedDB fires no change events, so the queue publishes its own. Without
    // this the list is read once at mount and a request queued afterwards is
    // invisible for as long as the tab stays open.
    return watchOutbox(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (!online) return
    // The network came back, or the app started with one. Either way, whatever
    // is waiting has waited long enough.
    void drain()
  }, [online, drain])

  return { queued, drain }
}
