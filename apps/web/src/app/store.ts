import { configureStore } from "@reduxjs/toolkit"
import { setupListeners } from "@reduxjs/toolkit/query"
import { authApi } from "../features/auth/api.js"
import { authSlice } from "../features/auth/authSlice.js"

/**
 * One store, assembled here so a test can build its own with the same shape.
 *
 * `makeStore` exists rather than a single exported instance because module
 * state leaks between test files: a store created at import time carries one
 * test's session into the next, and the failure shows up as an unrelated test
 * being "flaky".
 */
export function makeStore() {
  const store = configureStore({
    reducer: {
      [authSlice.reducerPath]: authSlice.reducer,
      [authApi.reducerPath]: authApi.reducer,
    },
    middleware: (getDefault) => getDefault().concat(authApi.middleware),
  })

  /**
   * Refetch on reconnect, which is half of what FR-8 asks of a client on a bad
   * connection: when the network returns, what is on screen should stop being
   * whatever was true before it went away.
   *
   * `refetchOnFocus` is deliberately left off — a wallet that reloads every
   * time the user switches apps spends their data allowance to show them the
   * same number.
   */
  setupListeners(store.dispatch)
  return store
}

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore["getState"]>
export type AppDispatch = AppStore["dispatch"]
