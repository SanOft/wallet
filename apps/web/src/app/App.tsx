import { setupListeners } from "@reduxjs/toolkit/query"
import { type ReactNode, useEffect, useState } from "react"
import { Provider } from "react-redux"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router"
import { ErrorBoundary } from "../components/ErrorBoundary.js"
import { LoginScreen } from "../features/auth/LoginScreen.js"
import { RegisterScreen } from "../features/auth/RegisterScreen.js"
import { useSessionRestore } from "../features/auth/useSessionRestore.js"
import { FormShowcase } from "../screens/FormShowcase.js"
import { History } from "../screens/History.js"
import { Home } from "../screens/Home.js"
import { NotFound } from "../screens/NotFound.js"
import { Profile } from "../screens/Profile.js"
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
