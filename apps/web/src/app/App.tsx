import { BrowserRouter, Route, Routes } from "react-router"
import { History } from "../screens/History.js"
import { Home } from "../screens/Home.js"
import { NotFound } from "../screens/NotFound.js"
import { Profile } from "../screens/Profile.js"
import { TabBar } from "./TabBar.js"

/**
 * The shell: §13.3's three tabs, and the room the fixed tab bar occupies.
 *
 * The screens here are placeholders. F0 delivers the system they will be built
 * from — tokens, layout, routing — and deliberately not the screens themselves,
 * because a design system judged only against screens that do not exist yet is
 * judged against nothing.
 */
export function App() {
  return (
    <BrowserRouter>
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
          // it. Its height plus the home-indicator inset plus a gap.
          paddingBottom: "calc(var(--touch-target-min) + var(--safe-bottom) + var(--spacing-xl))",
        }}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/history" element={<History />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <TabBar />
    </BrowserRouter>
  )
}
