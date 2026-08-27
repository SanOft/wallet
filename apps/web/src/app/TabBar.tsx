import { History, House, User } from "lucide-react"
import type { ComponentType } from "react"
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
  /**
   * Decorative. §13.7: every icon is `aria-hidden` and has a text equivalent,
   * so nothing here is the only way to learn what a tab does.
   *
   * `lucide-react` sets `aria-hidden` itself — verified, not assumed — so the
   * prop below is redundant today. It stays as a statement of intent, and
   * `icons.test.tsx` enforces the rule for anything hand-written that lucide
   * would not cover.
   *
   * SVG rather than emoji, and the difference is not cosmetic. An emoji is
   * text: a screen reader announces its Unicode name — "house with garden" —
   * next to the label that already says the same thing, it ignores
   * `currentColor`, and it renders as a different picture on every platform.
   */
  readonly Icon: ComponentType<{ readonly size?: number; readonly "aria-hidden"?: boolean }>
}

const TABS: readonly Tab[] = [
  { to: "/", label: "Asosiy", Icon: House },
  { to: "/history", label: "Tarix", Icon: History },
  { to: "/profile", label: "Profil", Icon: User },
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
                  <tab.Icon size={22} aria-hidden={true} />
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
