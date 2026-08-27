/**
 * @vitest-environment node
 *
 * This file reads the stylesheet from disk. Under jsdom `import.meta.url` is an
 * http URL, so `new URL(..., import.meta.url)` cannot be handed to `readFile`.
 * Nothing here touches a DOM.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { SRC, scan } from "./token-scan.js"

/**
 * §13.2: "Writing raw hex/px values inside components is forbidden."
 *
 * The spec prescribes a stylelint rule for this, and that would not work. In a
 * Tailwind v4 codebase the likeliest way a raw colour arrives is
 * `className="bg-[#175CD3]"` — inside a `.tsx` file, which a CSS linter never
 * reads. The rule is lexical and spans two languages, so it is enforced here,
 * over both.
 *
 * The checker is exercised against crafted samples as well as the real tree. A
 * rule that has only ever been run against clean code is indistinguishable from
 * a rule that matches nothing.
 */

function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      files.push(...walk(path))
      continue
    }
    if (/\.(tsx?|css)$/.test(entry)) files.push(path)
  }
  return files
}

describe("only layer 1 may contain a literal (§13.2)", () => {
  it("finds none in the source tree", () => {
    const violations = walk(SRC).flatMap((path) =>
      scan(readFileSync(path, "utf8"), relative(SRC, path)),
    )

    const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.rule}: ${v.text}`).join("\n")
    expect(violations, `use a token instead:\n${report}`).toEqual([])
  })

  it("catches a Tailwind arbitrary colour, which is the realistic case", () => {
    // The one a CSS linter cannot see, and therefore the one worth naming.
    const found = scan(`<div className="bg-[#175CD3]" />`, "screens/Home.tsx")
    expect(found).toHaveLength(1)
    expect(found[0]?.rule).toBe("raw colour")
  })

  it("catches a hex in a stylesheet that is not the token layer", () => {
    const found = scan("a { color: #ff0000; }", "styles/buttons.css")
    expect(found).toHaveLength(1)
  })

  it("catches a raw pixel value", () => {
    const found = scan(`<span style={{ fontSize: "14px" }} />`, "app/TabBar.tsx")
    expect(found[0]?.rule).toBe("raw px")
  })

  it("permits both inside the token layer, and only there", () => {
    const declaration = "--gray-900: #101828; --radius-card: 12px;"
    expect(scan(declaration, "styles/tokens.css")).toEqual([])
    expect(scan(declaration, "styles/other.css")).not.toEqual([])
  })

  it("ignores prose, including prose about the rule itself", () => {
    expect(scan("// checked at 320px and #ffffff", "screens/Home.tsx")).toEqual([])
    expect(scan("/* 1280px wide, #101828 text */", "styles/other.css")).toEqual([])
  })

  it("still catches a value on a line that also carries a comment", () => {
    // The obvious way to defeat comment-stripping is to hide behind one.
    const found = scan(`const gap = "12px" // spacing`, "app/App.tsx")
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe("12px")
  })

  it("permits a token reference, which is the whole point", () => {
    const usage = `<div style={{ padding: "var(--spacing-s)" }} className="text-(--color-text)" />`
    expect(scan(usage, "screens/Home.tsx")).toEqual([])
  })
})
