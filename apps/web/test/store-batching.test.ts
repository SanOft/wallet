import { SHOULD_AUTOBATCH } from "@reduxjs/toolkit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeStore } from "../src/app/store.js"

/**
 * The store notifies on a microtask, and schedules nothing that can outlive a
 * test file (P-39).
 *
 * Redux Toolkit's default batching is `raf`, and its implementation schedules
 * two things per notification: the animation frame, and a 100 ms `setTimeout`
 * as a fallback, whichever fires first cancelling the other with
 * `cancelAnimationFrame`. Vitest tears the jsdom environment down between
 * files, so that fallback timer can fire into a world with no
 * `cancelAnimationFrame` and throw where no test can catch it. CI showed
 * exactly that once: 25 files passed, 298 tests passed, and the run failed on
 * a single uncaught `ReferenceError` from a `Timeout.callback`.
 *
 * The flake could not be reproduced on demand, so this does not try to. It
 * asserts the property that makes it impossible instead — that nothing is left
 * pending — which is checkable every run rather than occasionally.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe("how the store schedules its notifications", () => {
  it("queues no animation frame and no timer for a batched action", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame")
    const timer = vi.spyOn(window, "setTimeout")

    const store = makeStore()
    store.subscribe(() => {})

    /*
     * `SHOULD_AUTOBATCH` is the flag Redux Toolkit's own query actions carry;
     * an unflagged action notifies synchronously and would pass this whatever
     * the batching setting is, which would make the test decorative.
     */
    store.dispatch({ type: "p39/probe", meta: { [SHOULD_AUTOBATCH]: true } })

    expect(raf, "the store scheduled an animation frame").not.toHaveBeenCalled()
    expect(timer, "the store scheduled a fallback timer").not.toHaveBeenCalled()
  })

  it("still notifies its subscribers", async () => {
    /*
     * Guards the guard: a store that scheduled nothing because it had stopped
     * notifying at all would satisfy the assertion above.
     *
     * It asserts only that the notification arrives, not when. An earlier
     * version required it to be deferred and was wrong — the subscriber is
     * called more than once per dispatch here, so "synchronous" and "batched"
     * are not the clean opposites they look like from outside. The assertion
     * that batching is configured the way this file claims is the animation
     * frame above, which fails under `raf` and passes under `tick`.
     */
    const store = makeStore()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.dispatch({ type: "p39/probe", meta: { [SHOULD_AUTOBATCH]: true } })
    await Promise.resolve()

    expect(notified, "the store stopped notifying altogether").toBeGreaterThan(0)
  })
})
