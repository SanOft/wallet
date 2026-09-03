import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The Redux DevTools extension gives anyone with the browser extension
 * installed a live read of every dispatched action and the full state tree —
 * account balances and transfer details included. `configureStore` wires it
 * up by default, so it takes an explicit `devTools: import.meta.env.DEV` to
 * keep a production build from shipping that window into a stranger's phone.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe("devtools stay out of a production build", () => {
  it("never calls the devtools compose hook when import.meta.env.DEV is false", async () => {
    /*
     * The real extension's compose hook returns a composer that folds the
     * store enhancers into one; a bare `vi.fn()` returns `undefined` instead
     * and `configureStore` throws on it before the assertion below ever runs,
     * turning a control failure into an unrelated crash. Returning a working
     * composer keeps the store buildable so the spy's call count is what
     * actually gets checked.
     */
    const compose = vi.fn(
      () =>
        (...enhancers: unknown[]) =>
          enhancers[0],
    )
    Object.defineProperty(window, "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", {
      configurable: true,
      value: compose,
    })

    const originalDev = import.meta.env.DEV
    import.meta.env.DEV = false

    /*
     * @reduxjs/toolkit reads `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`
     * once, at module evaluation, and binds its internal `composeWithDevTools`
     * to whatever it finds there. The spy above has to exist before `store.ts`
     * (and the toolkit it pulls in) is imported for the first time, so the
     * import is dynamic and deferred to here rather than hoisted to the top of
     * the file, where it would already have run against a bare `window`.
     */
    const { makeStore } = await import("../src/app/store.js")

    try {
      makeStore()
    } finally {
      import.meta.env.DEV = originalDev
    }

    expect(compose, "the store reached for the devtools compose hook").not.toHaveBeenCalled()
  })
})
