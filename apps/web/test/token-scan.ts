import { fileURLToPath } from "node:url"

/** The tree the rule governs. Components live here; the token layer does too. */
export const SRC = fileURLToPath(new URL("../src", import.meta.url))

/**
 * The one file allowed literals: layer 1 is where a value stops being a
 * decision and becomes a number.
 */
const ALLOWED = ["styles/tokens.css"]

const RULES = [
  { name: "raw colour", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "raw px", pattern: /\b\d+(?:\.\d+)?px\b/g },
] as const

export interface Violation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly text: string
}

/**
 * Blanks out comments, keeping the line count so a report still points at the
 * right line.
 *
 * The rule is about values the browser sees, not words a reader does. Without
 * this, a comment explaining the breakpoints — "checked at 320, 360, 768 and
 * 1280px" — trips the rule it is describing, and a linter that flags its own
 * documentation is a linter someone turns off.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix)
}

/**
 * The token rule from §13.2, as a function so the suite can exercise it on
 * crafted input as well as on the real tree. A rule that has only ever run
 * against clean code is indistinguishable from a rule that matches nothing.
 */
export function scan(source: string, file: string): Violation[] {
  if (ALLOWED.some((allowed) => file.replaceAll("\\", "/").endsWith(allowed))) return []

  const found: Violation[] = []
  const lines = withoutComments(source).split("\n")
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        found.push({ file, line: index + 1, rule: rule.name, text: match[0] })
      }
    }
  }
  return found
}
