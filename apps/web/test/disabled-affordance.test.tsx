/**
 * @vitest-environment node
 *
 * Reads the stylesheet from disk, like `tokens-only.test.ts`. Nothing here
 * touches a DOM — jsdom does not apply a stylesheet, so asserting a computed
 * opacity in a component test would assert nothing.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * A control that cannot be pressed must not look like one that can.
 *
 * Every disabled button in this application rendered identically to an enabled
 * one — `disabled` was set on eight components and not one of them said so.
 * The transfer wizard's "Davom etish" was full brand blue with white text while
 * refusing every press, which is how a user concludes the recipient search is
 * broken: the search had worked, and the button that looked ready was the one
 * that was not. It was reported as "why does the search find nothing".
 *
 * Asserted against the stylesheet rather than a rendered component, because
 * the fix is deliberately a base rule and not a class each button remembers to
 * add. A per-component assertion would pass for the seven that were wrong.
 */

const TOKENS = readFileSync(
  fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
  "utf8",
)

/** The declaration block for a selector, comments stripped. */
function ruleFor(selector: string): string {
  const withoutComments = TOKENS.replace(/\/\*[\s\S]*?\*\//g, "")
  const start = withoutComments.indexOf(selector)
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)

  const open = withoutComments.indexOf("{", start)
  const close = withoutComments.indexOf("}", open)
  return withoutComments.slice(open + 1, close)
}

describe("a disabled control says so", () => {
  it("dims every disabled button, wherever it is written", () => {
    const rule = ruleFor("button:disabled")
    expect(rule).toMatch(/opacity:\s*0?\.\d+/)
  })

  it("says it to a pointer as well", () => {
    // Before the click, not after nothing happens.
    expect(ruleFor("button:disabled")).toContain("not-allowed")
  })

  it("covers the aria form too, not only the native one", () => {
    /*
     * A control that is `aria-disabled` rather than `disabled` — the pattern
     * for something that must stay focusable — has exactly the same problem
     * and is easier to miss, because nothing in the browser dims it for free.
     */
    const withoutComments = TOKENS.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(withoutComments).toContain('[aria-disabled="true"]')
  })

  it("uses a signal that is not colour (NFR-4)", () => {
    /*
     * Opacity survives a colour-blind reader and works in both themes, which a
     * grey-on-grey palette swap would not. §13.2's dark mode re-declares layer
     * 2, so any colour chosen here would have needed two answers.
     */
    const rule = ruleFor("button:disabled")
    expect(rule).not.toMatch(/color:|background/)
  })
})
