import { setupListeners } from "@reduxjs/toolkit/query"
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react"
import { Provider } from "react-redux"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router"
import { ConnectionBanner } from "../components/ConnectionBanner.js"
import { ErrorBoundary } from "../components/ErrorBoundary.js"
import { LoginScreen } from "../features/auth/LoginScreen.js"
import { RegisterScreen } from "../features/auth/RegisterScreen.js"
import { useSessionRestore } from "../features/auth/useSessionRestore.js"
import { NotFound } from "../screens/NotFound.js"
import { useAppSelector } from "./hooks.js"
import { makeStore } from "./store.js"
import { TabBar } from "./TabBar.js"
import { UpdatePrompt } from "./UpdatePrompt.js"

/**
 * The gap `status: "unknown"` exists for.
 *
 * The access token lives in memory (FR-2.4), so a reload starts without one and
 * the cookie has to be asked before anything can be decided. Rendering the
 * login screen during that moment logs a signed-in user out on every refresh —
 * a bug that looks exactly like an expired session, which is why it survives.
 *
 * Deliberately almost empty. A spinner that flashes for eighty milliseconds is
 * noisier than nothing; this reserves the space and says what it is doing to
 * anyone who cannot see it.
 */
/**
 * The signed-in screens, fetched when they are first needed.
 *
 * Measured, not guessed: Lighthouse reported 52% of a 127 KB bundle unused on
 * the login screen, because rendering a password field was pulling in the
 * balance card, the history list, the rates widget and every endpoint they
 * use. That is the whole application downloaded to show a form, on the
 * connection NFR-3 is written for.
 *
 * The login and registration screens stay eager. They are the first paint for
 * anyone who is not signed in, and splitting the thing you are about to render
 * only adds a round trip.
 *
 * Offline is unaffected: the service worker precaches every emitted chunk, so
 * a split route is available offline from the second visit exactly as the
 * shell is. The first visit is the one that pays, and it pays less than before.
 */
const Home = lazy(() => import("../screens/Home.js").then((m) => ({ default: m.Home })))
const History = lazy(() => import("../screens/History.js").then((m) => ({ default: m.History })))
const Profile = lazy(() => import("../screens/Profile.js").then((m) => ({ default: m.Profile })))
const FormShowcase = lazy(() =>
  import("../screens/FormShowcase.js").then((m) => ({ default: m.FormShowcase })),
)

/**
 * What a route shows while its code is in flight.
 *
 * Deliberately near-empty, for the same reason `Deciding` is: a spinner that
 * flashes for eighty milliseconds is noisier than nothing. The sr-only line is
 * not optional though — without it a screen reader is told nothing at all
 * while the page is blank, which is indistinguishable from the app having
 * stopped.
 */
function LoadingRoute() {
  return (
    <p role="status" className="m-0">
      <span className="sr-only">Yuklanmoqda</span>
    </p>
  )
}

function Deciding() {
  return (
    <p role="status" className="m-0 text-(--color-text-secondary)">
      <span className="sr-only">Sessiya tekshirilmoqda</span>
    </p>
  )
}

function RequireAuth(props: { readonly children: ReactNode }) {
  const status = useAppSelector((state) => state.auth.status)
  const location = useLocation()

  if (status === "unknown") return <Deciding />
  if (status === "anonymous") {
    // `replace`, and carrying where they were headed: signing in should land
    // on the page they asked for, and the back button should not walk them
    // into a login screen they already passed.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{props.children}</>
}

function RedirectIfSignedIn(props: { readonly children: ReactNode }) {
  const status = useAppSelector((state) => state.auth.status)

  if (status === "unknown") return <Deciding />
  if (status === "authenticated") return <Navigate to="/" replace />
  return <>{props.children}</>
}

function Shell() {
  useSessionRestore()
  const status = useAppSelector((state) => state.auth.status)

  return (
    <>
      {/*
        Above the skip link's target and outside `main`, so it is the first
        thing announced and does not move the page content when it appears.
      */}
      <ConnectionBanner />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-s focus:top-s focus:z-20 focus:rounded-(--radius-control) focus:bg-(--color-primary) focus:px-s focus:py-2xs focus:text-(--color-on-primary)"
      >
        Asosiy qismga o&apos;tish
      </a>

      <main
        id="main"
        className="mx-auto w-full max-w-[42rem] px-s"
        style={{
          paddingTop: "calc(var(--safe-top) + var(--spacing-s))",
          // The tab bar is fixed, so the last card would otherwise sit under
          // it — but only when there is one.
          paddingBottom:
            status === "authenticated"
              ? "calc(var(--touch-target-min) + var(--safe-bottom) + var(--spacing-xl))"
              : "var(--spacing-xl)",
        }}
      >
        {/*
          One boundary around the routes rather than one per lazy element: the
          fallback is identical for all of them, and Suspense inside the router
          keeps the tab bar and the banner mounted while a screen arrives.
        */}
        <Suspense fallback={<LoadingRoute />}>
          <Routes>
            <Route
              path="/login"
              element={
                <RedirectIfSignedIn>
                  <LoginScreen />
                </RedirectIfSignedIn>
              }
            />
            <Route
              path="/register"
              element={
                <RedirectIfSignedIn>
                  <RegisterScreen />
                </RedirectIfSignedIn>
              }
            />

            <Route
              path="/"
              element={
                <RequireAuth>
                  <Home />
                </RequireAuth>
              }
            />
            <Route
              path="/history"
              element={
                <RequireAuth>
                  <History />
                </RequireAuth>
              }
            />
            {/*
            F0's design-system showcase, kept reachable rather than deleted:
            its definition of done is a visual check at four widths and in both
            themes, and that check needs somewhere to live now that the real
            Home has taken the route it used to occupy.
          */}
            <Route
              path="/design"
              element={
                <RequireAuth>
                  <FormShowcase />
                </RequireAuth>
              }
            />
            <Route
              path="/profile"
              element={
                <RequireAuth>
                  <Profile />
                </RequireAuth>
              }
            />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      {/* Hidden while signed out: three tabs that all bounce to the login
          screen are three ways to be told no. */}
      {status === "authenticated" ? <TabBar /> : null}

      {/*
        Outside the session gate: a new build matters whether or not anyone is
        signed in, and the login screen is exactly where a stale bundle is
        least obvious.
      */}
      <UpdatePrompt />
    </>
  )
}

/**
 * One store per mount, and the comment now matches the code.
 *
 * It used to be a module-level constant, which is one store per *module* — so
 * every test in a file shared a session, and once one of them resolved to
 * anonymous no later test could ever be signed in. The bug was invisible until
 * a test needed the opposite state of its neighbours.
 *
 * `useState` with an initialiser rather than `useMemo`: this must be created
 * exactly once per mount, and `useMemo` is a performance hint React is allowed
 * to discard.
 */
export function App() {
  const [store] = useState(makeStore)

  /**
   * Online/offline listening, tied to this mount rather than to the module.
   *
   * `setupListeners` used to run inside `makeStore`, which registers window
   * listeners and returns an unsubscribe nobody called. One App in production
   * makes that harmless; in tests it meant every store ever built stayed
   * subscribed, so a reconnect refetched through instances that had been
   * unmounted — and a test could watch a request go out that the component
   * under test had not made. Cleaning up here is also what makes the leak
   * impossible to reintroduce quietly.
   */
  useEffect(() => setupListeners(store.dispatch), [store])

  return (
    <Provider store={store}>
      <BrowserRouter>
        {/*
          The last resort, below the section boundaries: something outside any
          screen — the router, the tab bar, the session gate — can still throw,
          and without this the page goes white with no explanation and no way
          back.
        */}
        <ErrorBoundary scope="shell" title="Ilovani ko'rsatib bo'lmadi.">
          <Shell />
        </ErrorBoundary>
      </BrowserRouter>
    </Provider>
  )
}
