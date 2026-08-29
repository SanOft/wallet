import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit"
import { authApi } from "../features/auth/api.js"
import { authSlice, signedOut } from "../features/auth/authSlice.js"
import { transferSlice } from "../features/transfer/transferSlice.js"
import { clearOutbox } from "../lib/outbox.js"
import { clearReadCache } from "../lib/readCache.js"
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
/**
 * Empties the offline read cache the moment anyone signs out.
 *
 * A listener rather than a call at each `signedOut` dispatch, because there
 * are three of them — an explicit sign-out, a refresh that returned 401, and
 * reuse detection — and a cleanup that must be remembered in three places is
 * one that will be missed in the fourth.
 *
 * This is a security requirement, not tidiness. The records are one person's
 * balance and one person's transfers, and a shared phone is the common case in
 * this market rather than the edge case. Without this, the next person to open
 * the app sees the previous person's money on a screen that correctly labels
 * it as theirs.
 */
function sessionCleanup() {
  const listener = createListenerMiddleware()

  listener.startListening({
    actionCreator: signedOut,
    effect: async () => {
      /*
       * Both stores. A queued item is one person's money instruction carrying
       * their idempotency key: sending it after they signed out would use a
       * session that is no longer theirs, and leaving it puts their pending
       * transfer on the next person's screen.
       */
      await clearReadCache()
      await clearOutbox()
    },
  })

  return listener
}

export function makeStore() {
  const cleanup = sessionCleanup()

  const store = configureStore({
    reducer: {
      [authSlice.reducerPath]: authSlice.reducer,
      [transferSlice.reducerPath]: transferSlice.reducer,
      [authApi.reducerPath]: authApi.reducer,
      [walletApi.reducerPath]: walletApi.reducer,
    },
    middleware: (getDefault) =>
      // Before the API middleware: the cache must be gone by the time anything
      // reacts to the sign-out and starts fetching again.
      getDefault().prepend(cleanup.middleware).concat(authApi.middleware, walletApi.middleware),
  })

  return store
}

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore["getState"]>
export type AppDispatch = AppStore["dispatch"]
