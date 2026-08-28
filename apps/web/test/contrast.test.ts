/**
 * @vitest-environment node
 *
 * This file reads the stylesheet from disk. Under jsdom `import.meta.url` is an
 * http URL, so `new URL(..., import.meta.url)` cannot be handed to `readFile`.
 * Nothing here touches a DOM.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * §13.2.2's contrast table, checked against the stylesheet it describes.
 *
 * The table lists a computed ratio for every semantic pair. Numbers in a
 * document decay: someone adjusts a hex, the table keeps the old figure, and
 * the claim "WCAG-verified" survives in prose long after it stopped being true.
 * This reads `tokens.css` — not a copy of the values — resolves layer 2 through
 * layer 1, and recomputes.
 *
 * Both halves are asserted. The threshold is the requirement (NFR-4: 4.5:1 for
 * text). The documented figure is the claim, and a change that improves
 * contrast should still fail here until the table is updated to match, because
 * a table nobody updates is the thing being prevented.
 */

const CSS = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8")

/** `--gray-900: #101828` — layer 1, the only place a literal colour may appear. */
function primitives(): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, name, hex] of CSS.matchAll(/--([a-z]+-\d+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    if (name && hex) found.set(name, hex)
  }
  return found
}

/**
 * The declarations inside one brace-delimited block, by its opening text.
 * None of the blocks in this file nest, so the first `}` closes them.
 */
function block(opener: string): Map<string, string> {
  const start = CSS.indexOf(opener)
  if (start === -1) throw new Error(`tokens.css has no ${opener.trim()} block`)
  const body = CSS.slice(start + opener.length, CSS.indexOf("}", start))

  const declarations = new Map<string, string>()
  for (const [, name, value] of body.matchAll(/(--color-[a-z-]+):\s*var\((--[a-z]+-\d+)\)\s*;/g)) {
    if (name && value) declarations.set(name, value.replace("--", ""))
  }
  return declarations
}

function resolve(theme: Map<string, string>, token: string): string {
  const primitive = theme.get(token)
  if (!primitive) throw new Error(`${token} is not declared in this theme`)
  const hex = primitives().get(primitive)
  if (!hex) throw new Error(`${token} points at --${primitive}, which has no value`)
  return hex
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  )
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const [r, g, b] = linear as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const light = block("@theme {")
const dark = block(':root[data-theme="dark"] {')

/** The rows of §13.2.2, as data. */
const PAIRS = [
  { fg: "--color-text", bg: "--color-background", light: 17.75, dark: 17.06 },
  { fg: "--color-text-secondary", bg: "--color-background", light: 7.69, dark: 7.32 },
  { fg: "--color-primary", bg: "--color-background", light: 5.99, dark: 8.44 },
  { fg: "--color-on-primary", bg: "--color-primary", light: 5.99, dark: 8.44 },
  { fg: "--color-success", bg: "--color-background", light: 5.69, dark: 9.31 },
  { fg: "--color-danger", bg: "--color-background", light: 6.57, dark: 6.77 },
  { fg: "--color-warning", bg: "--color-background", light: 5.43, dark: 10.25 },
  { fg: "--color-text", bg: "--color-surface-sunken", light: 16.98, dark: 15.59 },
  { fg: "--color-danger", bg: "--color-surface-sunken", light: 6.29, dark: 6.18 },
] as const

/** NFR-4, and §13.2.2's own stated requirement. */
const MINIMUM = 4.5

describe("§13.2.2 — every semantic pair, recomputed from the stylesheet", () => {
  it.each(PAIRS)("$fg on $bg clears $MINIMUM:1 in both themes", (pair) => {
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ratio = contrast(resolve(tokens, pair.fg), resolve(tokens, pair.bg))
      expect(ratio, `${pair.fg} on ${pair.bg} (${theme})`).toBeGreaterThanOrEqual(MINIMUM)
    }
  })

  it.each(PAIRS)("$fg on $bg still measures what §13.2.2 claims", (pair) => {
    const measured = {
      light: contrast(resolve(light, pair.fg), resolve(light, pair.bg)),
      dark: contrast(resolve(dark, pair.fg), resolve(dark, pair.bg)),
    }
    // Two decimals is what the table publishes.
    expect(Number(measured.light.toFixed(2)), `${pair.fg} light`).toBe(pair.light)
    expect(Number(measured.dark.toFixed(2)), `${pair.fg} dark`).toBe(pair.dark)
  })
})

describe("the layers stay separated", () => {
  it("declares the same semantic names in both themes", () => {
    // A token added to light and forgotten in dark is invisible until someone
    // switches theme on the one screen that uses it.
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort())
  })

  it("gives every semantic token a primitive, never a literal", () => {
    // Layer 2 exists to name a decision. A hex here would put the decision
    // back in the place layer 1 was created to hold.
    const themeBody = CSS.slice(CSS.indexOf("@theme {"), CSS.indexOf("}", CSS.indexOf("@theme {")))
    const literals = themeBody.match(/--color-[a-z-]+:\s*#[0-9a-fA-F]/g)
    expect(literals, "a semantic token was given a raw colour").toBeNull()
  })

  it("keeps dark mode to layer 2 alone", () => {
    // §13.2: "dark mode is nothing more than re-declaring layer 2". If a
    // primitive were redefined under the dark selector, the layering would be
    // decorative — every consumer of that primitive would silently change too.
    const darkStart = CSS.indexOf(':root[data-theme="dark"] {')
    const darkBody = CSS.slice(darkStart, CSS.indexOf("}", darkStart))
    expect(darkBody.match(/--[a-z]+-\d+:/g), "a primitive was redefined for dark mode").toBeNull()
  })
})
