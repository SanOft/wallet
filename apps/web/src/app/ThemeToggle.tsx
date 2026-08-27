import { useEffect, useState } from "react"

type Theme = "system" | "light" | "dark"

const STORAGE_KEY = "wallet.theme"

/**
 * Three states, not two.
 *
 * A two-state toggle has to pick a starting side, which means it either ignores
 * the operating system or silently claims to follow it. Keeping "system" as its
 * own value is the only way the user can hand the decision back after having
 * once made it — and it is why the stylesheet guards the media query with
 * `:not([data-theme="light"])` rather than relying on order.
 */
function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    // Private browsing, or a browser configured to refuse site data. A theme
    // preference is not worth failing a render over.
    return "system"
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStored)

  useEffect(() => {
    const root = document.documentElement
    if (theme === "system") root.removeAttribute("data-theme")
    else root.setAttribute("data-theme", theme)

    try {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // See readStored: the preference simply does not persist.
    }
  }, [theme])

  return (
    <div className="flex flex-col gap-3xs">
      <label htmlFor="theme" className="text-step--1 text-(--color-text-secondary)">
        Mavzu
      </label>
      <select
        id="theme"
        value={theme}
        onChange={(event) => setTheme(event.target.value as Theme)}
        className="rounded-(--radius-control) border border-(--color-neutral) bg-(--color-background) px-2xs text-(--color-text)"
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        <option value="system">Tizim</option>
        <option value="light">Yorug&apos;</option>
        <option value="dark">Qorong&apos;i</option>
      </select>
    </div>
  )
}
