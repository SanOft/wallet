import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeToggle } from "../src/app/ThemeToggle.js"

/**
 * §13.2: dark mode is re-declaring layer 2, and nothing else.
 *
 * `contrast.test.ts` proves the stylesheet holds up that claim. This proves the
 * control that switches between them, including the case a two-state toggle
 * cannot express: handing the decision back to the operating system.
 */

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme")
  window.localStorage.clear()
})

describe("the theme control", () => {
  it("starts on the system setting, claiming neither", () => {
    render(<ThemeToggle />)
    expect(screen.getByLabelText(/mavzu/i)).toHaveValue("system")
    // No attribute at all: the stylesheet's media query decides.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
  })

  it("stamps an explicit choice on the root", async () => {
    render(<ThemeToggle />)
    await userEvent.selectOptions(screen.getByLabelText(/mavzu/i), "dark")

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
  })

  it("can override the system in either direction", async () => {
    // The reason the stylesheet guards its media query with
    // `:not([data-theme="light"])`: choosing light on a dark system has to win.
    render(<ThemeToggle />)
    await userEvent.selectOptions(screen.getByLabelText(/mavzu/i), "light")

    expect(document.documentElement.getAttribute("data-theme")).toBe("light")
  })

  it("gives the decision back when asked", async () => {
    render(<ThemeToggle />)
    const select = screen.getByLabelText(/mavzu/i)

    await userEvent.selectOptions(select, "dark")
    await userEvent.selectOptions(select, "system")

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    expect(window.localStorage.getItem("wallet.theme")).toBeNull()
  })

  it("remembers an explicit choice across a reload", async () => {
    const { unmount } = render(<ThemeToggle />)
    await userEvent.selectOptions(screen.getByLabelText(/mavzu/i), "dark")
    unmount()

    render(<ThemeToggle />)
    expect(screen.getByLabelText(/mavzu/i)).toHaveValue("dark")
  })

  it("renders when storage refuses, rather than failing the page", () => {
    // Private browsing, or a browser configured to block site data. A theme
    // preference is not worth a blank screen.
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied")
    })

    expect(() => render(<ThemeToggle />)).not.toThrow()
    expect(screen.getByLabelText(/mavzu/i)).toHaveValue("system")

    denied.mockRestore()
  })
})
