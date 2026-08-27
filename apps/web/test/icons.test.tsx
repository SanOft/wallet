import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { App } from "../src/app/App.js"
import { FormField } from "../src/components/FormField.js"

/**
 * §13.7: "All icons are `aria-hidden` and have a text equivalent."
 *
 * An unlabelled `<svg>` is announced as "graphic", or by a filename; a labelled
 * one duplicates the sentence beside it. Both make a screen reader slower to
 * use than the screen is.
 *
 * `lucide-react` sets `aria-hidden` itself — checked, not assumed — so every
 * icon shipping today satisfies this by construction. That is exactly why the
 * rule is written as a checker with its own failing case rather than as an
 * assertion over the current tree: a rule that cannot fail is a rule that has
 * stopped being a rule, and the first hand-written `<svg>` is the one it exists
 * to catch.
 */

interface Unlabelled {
  readonly outerHTML: string
  readonly near: string
}

/** Icons that are neither hidden nor named — the two shapes §13.7 allows. */
function unlabelledIcons(container: HTMLElement): Unlabelled[] {
  return [...container.querySelectorAll("svg")]
    .filter((svg) => {
      const hidden = svg.getAttribute("aria-hidden") === "true"
      const named = Boolean(svg.getAttribute("aria-label") ?? svg.getAttribute("aria-labelledby"))
      return !hidden && !named
    })
    .map((svg) => ({
      outerHTML: svg.outerHTML.slice(0, 60),
      near: svg.parentElement?.textContent?.trim().slice(0, 40) ?? "",
    }))
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
})

describe("the rule itself", () => {
  it("flags a bare svg", () => {
    const container = document.createElement("div")
    container.innerHTML = "<span><svg></svg>Asosiy</span>"
    expect(unlabelledIcons(container)).toHaveLength(1)
  })

  it("accepts a hidden one", () => {
    const container = document.createElement("div")
    container.innerHTML = '<svg aria-hidden="true"></svg>'
    expect(unlabelledIcons(container)).toEqual([])
  })

  it("accepts a named one, for the case where the icon is all there is", () => {
    const container = document.createElement("div")
    container.innerHTML = '<svg aria-label="Yopish"></svg>'
    expect(unlabelledIcons(container)).toEqual([])
  })
})

describe("every icon in the application obeys it", () => {
  it("holds across the shell, including the tab bar", () => {
    const { container } = render(<App />)

    // If this rendered nothing the rule would pass by finding nothing, which
    // is how an accessibility check quietly stops working.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0)

    const found = unlabelledIcons(container)
    expect(found, JSON.stringify(found, null, 2)).toEqual([])
  })

  it("holds for the error icon, where the sentence carries the meaning", () => {
    const { container } = render(
      <FormField label="Telefon" error="Raqam 9 ta raqamdan iborat bo'lishi kerak">
        {({ id }) => <input id={id} />}
      </FormField>,
    )

    expect(container.querySelectorAll("svg")).toHaveLength(1)
    expect(unlabelledIcons(container)).toEqual([])
  })

  it("keeps a non-colour signal beside the colour", () => {
    // NFR-4 and §13.6. Hidden from a screen reader and still the thing that
    // tells a colour-blind reader this is an error rather than a hint.
    const { container } = render(
      <FormField label="Summa" error="Eng kam summa — 1 000 so'm">
        {({ id }) => <input id={id} />}
      </FormField>,
    )

    expect(container.querySelector("svg")).not.toBeNull()
    expect(container.textContent).toContain("Eng kam summa")
  })

  it("names each tab in text, so the icon is never the only label", () => {
    const { container } = render(<App />)

    for (const tab of container.querySelectorAll("nav a")) {
      // The icon is hidden; without the label the tab would announce as an
      // empty link and be unreachable by name.
      expect(tab.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })
})
