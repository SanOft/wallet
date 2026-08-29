/**
 * @vitest-environment node
 *
 * This file reads the stylesheet from disk. Under jsdom `import.meta.url` is an
 * http URL, so `new URL(..., import.meta.url)` cannot be handed to `readFile`.
 * Nothing here touches a DOM.
 */
import { readdirSync, readFileSync } from "node:fs"
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
  /*
   * `--color-neutral` published a `—` in §13.2.2 while being used as text for
   * QUEUED rows and disabled controls. Not an oversight anybody had to find:
   * the table said out loud that this one was unmeasured, and it shipped.
   * Measured now, and the tighter of the two is the closest any pair in this
   * system comes to failing NFR-4.
   */
  { fg: "--color-neutral", bg: "--color-background", light: 4.97, dark: 5.31 },
  { fg: "--color-neutral", bg: "--color-surface-sunken", light: 4.76, dark: 4.85 },
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

/**
 * The pairs the components actually use, rather than the ones somebody listed.
 *
 * P-29: `PAIRS` above is a table, and F2 shipped `--color-danger` on
 * `--color-surface-sunken` — a combination that was in neither the table nor
 * this test, found by looking at a screenshot. A list cannot catch the case it
 * was not told about, which is the only case that matters.
 *
 * The obvious repair is to pair each element's own `color` with its own
 * `background`. Measured before writing it: nine elements in `src` set both,
 * and sixty-seven set a foreground token and inherit their background from an
 * ancestor. That repair would therefore check about an eighth of what ships,
 * and would miss precisely the inherited-background case that produced the
 * defect.
 *
 * So this does not try to pair by element at all. It takes every foreground
 * token any component uses, every background token any component uses, and
 * checks the whole product. That is stronger than pairing: it holds no matter
 * how components are nested, and stays true when one is moved inside another —
 * a rearrangement that changes which pairs exist but cannot introduce one this
 * has not already measured.
 *
 * The one exception is the `on-*` convention §13.2.2 states: "every background
 * color has an `on-*` counterpart — a component never has to guess which text
 * color will work on it." A background with a counterpart is spoken for, and
 * pairs with that counterpart alone. Without this the product is meaningless:
 * `--color-text` on `--color-primary` measures 2.96, and no component puts it
 * there.
 */

const SRC = new URL("../src/", import.meta.url)

function sourceFiles(dir: URL): readonly URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
    if (entry.isDirectory()) return sourceFiles(child)
    return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [child] : []
  })
}

const SOURCES = sourceFiles(SRC).map((file) => readFileSync(file, "utf8"))

function tokensMatching(patterns: readonly RegExp[]): ReadonlySet<string> {
  const found = new Set<string>()
  for (const source of SOURCES) {
    for (const pattern of patterns) {
      for (const [, token] of source.matchAll(pattern)) {
        if (token) found.add(token)
      }
    }
  }
  return found
}

/** `text-(--color-x)` and `color: "var(--color-x)"`. */
const FOREGROUNDS = tokensMatching([
  /text-\((--color-[a-z-]+)\)/g,
  /[^-]color:\s*"var\((--color-[a-z-]+)\)"/g,
])

/** `bg-(--color-x)` and `background: "var(--color-x)"`. */
const BACKGROUNDS = tokensMatching([
  /bg-\((--color-[a-z-]+)\)/g,
  /background:\s*"var\((--color-[a-z-]+)\)"/g,
])

/** The counterpart §13.2.2 promises, if this background has one. */
function counterpartOf(background: string): string | null {
  const named = background.replace("--color-", "--color-on-")
  return light.has(named) ? named : null
}

function derivedPairs(): readonly { readonly fg: string; readonly bg: string }[] {
  const pairs: { fg: string; bg: string }[] = []

  for (const bg of [...BACKGROUNDS].sort()) {
    const counterpart = counterpartOf(bg)
    /*
     * An `on-*` foreground is spoken for by its own background and is checked
     * there, so it is excluded here rather than measured against every surface
     * — `--color-on-primary` on `--color-background` is white on white.
     *
     * The test for that is the name, not whether a counterpart exists. Asking
     * "does this token have an `on-` twin" excludes `--color-primary` itself,
     * which is a foreground in its own right: §13.2.2 gives it "CTAs, links,
     * active tab", and it reaches the page background as link text.
     */
    const foregrounds = counterpart
      ? [counterpart]
      : [...FOREGROUNDS].filter((fg) => fg !== bg && !fg.startsWith("--color-on-"))

    for (const fg of foregrounds.sort()) pairs.push({ fg, bg })
  }

  return pairs
}

const DERIVED = derivedPairs()

describe("§13.2.2 — every combination the components can produce", () => {
  it("found the sources to read", () => {
    /*
     * The control. Every assertion below is `it.each` over a derived list, and
     * an empty list passes silently — a regex broken by a refactor would turn
     * this whole file green rather than red, which is the failure mode it
     * exists to prevent.
     */
    expect(SOURCES.length, "no component sources were read").toBeGreaterThan(30)
    expect(FOREGROUNDS.size, "no foreground tokens were found").toBeGreaterThan(4)
    expect(BACKGROUNDS.size, "no background tokens were found").toBeGreaterThan(1)
    expect(DERIVED.length, "no pairs were derived").toBeGreaterThan(PAIRS.length)
  })

  it("uses no colour token the stylesheet does not declare", () => {
    // A typo in a class name is otherwise invisible: the browser drops the
    // declaration and the element inherits, which usually still looks fine.
    for (const token of [...FOREGROUNDS, ...BACKGROUNDS]) {
      expect(light.has(token), `${token} is used in a component but not declared`).toBe(true)
    }
  })

  it.each(DERIVED)("$fg on $bg clears 4.5:1 in both themes", (pair) => {
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ratio = contrast(resolve(tokens, pair.fg), resolve(tokens, pair.bg))
      expect(ratio, `${pair.fg} on ${pair.bg} (${theme})`).toBeGreaterThanOrEqual(MINIMUM)
    }
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
