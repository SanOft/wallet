import { NavLink } from "react-router"

/**
 * The bottom tab bar, §13.1 and §13.3.
 *
 * Fixed to the bottom because that is the thumb zone on a 360×640 screen, and
 * padded by the home-indicator inset so the last row of pixels is reachable.
 * At ≥1024px it becomes a side rail (§13.2.3's rule that breakpoints survive
 * for layout and nothing else) — that lands with the first wide screen, not
 * here, because there is nothing yet to lay out beside it.
 */

interface Tab {
  readonly to: string
  readonly label: string
  /** Decorative: the label carries the meaning, so this is hidden (§13.7). */
  readonly glyph: string
}

const TABS: readonly Tab[] = [
  { to: "/", label: "Asosiy", glyph: "🏠" },
  { to: "/history", label: "Tarix", glyph: "📜" },
  { to: "/profile", label: "Profil", glyph: "👤" },
]

export function TabBar() {
  return (
    <nav
      aria-label="Asosiy navigatsiya"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-(--color-surface-sunken) bg-(--color-background)"
      style={{ paddingBottom: "var(--safe-bottom)" }}
    >
      <ul className="m-0 flex list-none justify-around p-0">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === "/"}
              className="flex flex-col items-center justify-center gap-3xs px-2xs no-underline"
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {({ isActive }) => (
                <>
                  <span aria-hidden="true" className="text-step-1">
                    {tab.glyph}
                  </span>
                  <span
                    className="text-step--1"
                    style={{
                      // Colour is never the only signal (§13.6): the active tab
                      // is also the one the router marks current, which is what
                      // a screen reader announces.
                      color: isActive ? "var(--color-primary)" : "var(--color-text-secondary)",
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {tab.label}
                  </span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
