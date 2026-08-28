import { configureStore } from "@reduxjs/toolkit"
import { authApi } from "../features/auth/api.js"
import { authSlice } from "../features/auth/authSlice.js"
import { walletApi } from "./api.js"

/*
 * The feature endpoint modules are deliberately *not* imported here.
 *
 * They were, for their `injectEndpoints` side effect, and that single line
 * silently undid route-level code splitting: importing them from the store
 * pulled the balance card, the history list and the rates widget into the
 * entry chunk, so the login screen downloaded the whole application to render
 * a password field. Lighthouse called it 52% unused JavaScript.
 *
 * RTK Query injects late by design. Each screen imports the endpoints it uses,
 * so they arrive with the chunk that needs them and the reducer picks them up
 * then — which is the behaviour the eager imports were guarding against
 * without ever being needed.
 */

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
      [walletApi.reducerPath]: walletApi.reducer,
    },
    middleware: (getDefault) => getDefault().concat(authApi.middleware, walletApi.middleware),
  })

  return store
}

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore["getState"]>
export type AppDispatch = AppStore["dispatch"]
