import { configureStore } from "@reduxjs/toolkit"
import { authApi } from "../features/auth/api.js"
import { authSlice } from "../features/auth/authSlice.js"
import { walletApi } from "./api.js"

/*
 * Imported for their side effect: `injectEndpoints` runs at module load, and a
 * store built without these has a `walletApi` slice with no endpoints in it.
 * The alternative — importing them from the components that use them — works
 * until a test renders one component and the reducer has never heard of the
 * others.
 */
import "../features/accounts/api.js"
import "../features/history/api.js"
import "../features/rates/api.js"

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
