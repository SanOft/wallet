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
 *
 * The control is a segmented group of icons now rather than a `<select>`, and
 * these tests are written through the roles rather than the markup — a radio
 * named "Qorong'i" is what a person looks for, and it is the assertion that
 * survives the next change of appearance.
 */

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme")
  window.localStorage.clear()
})

/** The segment a user would press, found the way they would find it. */
function option(name: RegExp) {
  return screen.getByRole("radio", { name })
}

describe("the theme control", () => {
  it("is one keyboard stop with three options, not three buttons", () => {
    /*
     * Three mutually exclusive choices is a radio group. Built from buttons it
     * would be three tab stops with no announced relationship and no arrow-key
     * movement — the same widget with the keyboard behaviour left out.
     */
    render(<ThemeToggle />)

    expect(screen.getAllByRole("radio")).toHaveLength(3)
    expect(screen.getByRole("group", { name: /mavzu/i })).toBeInTheDocument()
  })

  it("names every segment, though each one shows only an icon", () => {
    // §13.7: an icon is `aria-hidden` and has a text equivalent. Without it
    // this control is three graphics.
    render(<ThemeToggle />)

    expect(option(/tizim/i)).toBeInTheDocument()
    expect(option(/yorug/i)).toBeInTheDocument()
    expect(option(/qorong/i)).toBeInTheDocument()
  })

  it("starts on the system setting, claiming neither", () => {
    render(<ThemeToggle />)

    expect(option(/tizim/i)).toBeChecked()
    // No attribute at all: the stylesheet's media query decides.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
  })

  it("stamps an explicit choice on the root", async () => {
    render(<ThemeToggle />)
    await userEvent.click(option(/qorong/i))

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
  })

  it("can override the system in either direction", async () => {
    // The reason the stylesheet guards its media query with
    // `:not([data-theme="light"])`: choosing light on a dark system has to win.
    render(<ThemeToggle />)
    await userEvent.click(option(/yorug/i))

    expect(document.documentElement.getAttribute("data-theme")).toBe("light")
  })

  it("gives the decision back when asked", async () => {
    render(<ThemeToggle />)

    await userEvent.click(option(/qorong/i))
    await userEvent.click(option(/tizim/i))

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    expect(window.localStorage.getItem("wallet.theme")).toBeNull()
  })

  it("remembers an explicit choice across a reload", async () => {
    const { unmount } = render(<ThemeToggle />)
    await userEvent.click(option(/qorong/i))
    unmount()

    render(<ThemeToggle />)
    expect(option(/qorong/i)).toBeChecked()
  })

  it("renders when storage refuses, rather than failing the page", () => {
    // Private browsing, or a browser configured to block site data. A theme
    // preference is not worth a blank screen.
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied")
    })

    expect(() => render(<ThemeToggle />)).not.toThrow()
    expect(option(/tizim/i)).toBeChecked()

    denied.mockRestore()
  })
})
