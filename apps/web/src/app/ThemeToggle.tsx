import { Monitor, Moon, Sun } from "lucide-react"
import { useEffect, useId, useState } from "react"

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

/**
 * A segmented control built from real radio inputs, not from buttons.
 *
 * Three mutually exclusive options is what a radio group *is*, and using the
 * native element buys the behaviour rather than reimplementing it: arrow keys
 * move between segments, Tab enters and leaves the group as one stop, and a
 * screen reader announces "2 of 3" without any `aria-*` written by hand. The
 * `role="radiogroup"` + `aria-checked` version of this is the same widget with
 * the keyboard handling left as an exercise.
 *
 * The inputs are visually hidden rather than removed: `display: none` takes an
 * element out of the accessibility tree and out of tab order, which is the one
 * thing this must not do.
 */
const OPTIONS: readonly { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "Tizim", Icon: Monitor },
  { value: "light", label: "Yorug'", Icon: Sun },
  { value: "dark", label: "Qorong'i", Icon: Moon },
]

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
  const name = useId()

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
    <fieldset className="m-0 flex flex-col gap-3xs border-0 p-0">
      {/*
        The group needs a name even though the segments are icons. Visually
        hidden rather than shown: on a screen this small the control is beside
        the page heading and reads as what it is, while a screen reader would
        otherwise meet three unexplained options.
      */}
      <legend className="sr-only">Mavzu</legend>

      <div
        className="flex rounded-(--radius-control) border p-3xs"
        style={{ borderColor: "var(--color-neutral)" }}
      >
        {OPTIONS.map(({ value, label, Icon }) => {
          const active = theme === value
          return (
            <label
              key={value}
              className="flex flex-1 cursor-pointer items-center justify-center rounded-(--radius-control)"
              style={{
                minHeight: "var(--touch-target-min)",
                minWidth: "var(--touch-target-min)",
                background: active ? "var(--color-primary)" : "transparent",
                color: active ? "var(--color-on-primary)" : "var(--color-text-secondary)",
              }}
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={active}
                onChange={() => setTheme(value)}
                className="sr-only"
              />
              {/*
                §13.7: every icon is `aria-hidden` and has a text equivalent.
                The equivalent is the label beside it, which is what the radio
                is announced by — so the icon is decoration and the control is
                still called "Yorug'" rather than "graphic".
              */}
              <Icon size={18} aria-hidden={true} />
              <span className="sr-only">{label}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
