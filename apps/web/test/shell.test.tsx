import { screen } from "@testing-library/react"
import axe from "axe-core"
import { beforeEach, describe, expect, it } from "vitest"
import { renderSignedIn } from "./renderApp.js"

/**
 * The shell, checked for the things §13.7 asks for by name.
 *
 * axe runs in jsdom, which has no layout engine — so its colour-contrast rule
 * cannot execute here and reports as incomplete rather than passing. That gap
 * is why `contrast.test.ts` exists and computes the ratios from the stylesheet
 * directly, instead of trusting a browserless run to have checked them.
 */

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme")
  window.localStorage.clear()
  window.history.pushState({}, "", "/")
})

async function violations(container: HTMLElement): Promise<axe.Result[]> {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    // Nothing renders at a real size in jsdom, so these two would report on a
    // layout that does not exist. Touch size is asserted directly below.
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
  })
  return results.violations
}

describe("the application shell", () => {
  it("has no accessibility violations axe can detect without layout", async () => {
    const { container } = await renderSignedIn()
    const found = await violations(container)

    const report = found.map((v) => `${v.id}: ${v.help}`).join("\n")
    expect(found, report).toEqual([])
  })

  it("gives the navigation a name, because a page can have several", async () => {
    await renderSignedIn()
    expect(screen.getByRole("navigation", { name: /navigatsiya/i })).toBeInTheDocument()
  })

  it("offers exactly the three tabs §13.3 specifies", async () => {
    await renderSignedIn()
    const tabs = screen.getAllByRole("link").filter((link) => link.closest("nav"))
    expect(tabs.map((tab) => tab.textContent?.replace(/[^\p{L}']/gu, ""))).toEqual([
      "Asosiy",
      "Tarix",
      "Profil",
    ])
  })

  it("marks the current tab for a screen reader, not only in colour", async () => {
    // §13.6: colour is never the only signal. `aria-current` is what the router
    // sets and what a screen reader announces.
    await renderSignedIn()
    const current = screen.getAllByRole("link").filter((link) => link.closest("nav"))[0]
    expect(current).toHaveAttribute("aria-current", "page")
  })

  it("sizes every tab to the minimum touch target (NFR-3)", async () => {
    await renderSignedIn()
    for (const tab of screen.getAllByRole("link").filter((link) => link.closest("nav"))) {
      // The value is a token; asserting the token is asserting the rule, and
      // asserting 44px here would duplicate the number the token exists to own.
      expect(tab.getAttribute("style")).toContain("var(--touch-target-min)")
    }
  })

  it("carries a skip link, and keeps it out of the way until focused", async () => {
    await renderSignedIn()
    const skip = screen.getByRole("link", { name: /asosiy qismga/i })
    expect(skip).toHaveClass("sr-only")
    expect(skip).toHaveAttribute("href", "#main")
  })

  it("answers an unknown path with a way out rather than a dead end (§13.1)", async () => {
    window.history.pushState({}, "", "/there-is-no-such-screen")
    await renderSignedIn()

    expect(screen.getByRole("heading", { name: /topilmadi/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /asosiy sahifaga/i })).toBeInTheDocument()
  })
})
