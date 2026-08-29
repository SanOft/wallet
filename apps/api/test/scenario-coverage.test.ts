/**
 * @vitest-environment node
 *
 * Reads `docs/spec.md` and the test directories from disk. Nothing here
 * touches a DOM.
 */
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * §18.2's mandatory scenarios, as a gate rather than as a heading.
 *
 * The table is titled "no merge unless they pass", which is a claim about CI.
 * Nothing checked it. S-8 and S-9 were both genuinely covered — three wrong
 * PINs blocking the USSD channel, and a queued transfer that is never called
 * sent — but neither test carried its scenario number, so the only way to know
 * the gate held was to read nine rows and go looking. That is the same shape
 * as P-29: a table verified by reading is a table that drifts, and the drift
 * is invisible because everything is green either way.
 *
 * This does not check that the scenarios are *well* tested. It checks that
 * each one is claimed by a test, which is the part a table cannot do for
 * itself. A label is a weaker guarantee than a review, and it is a guarantee
 * that survives the reviewer leaving.
 */

const ROOT = new URL("../../../", import.meta.url)
const SPEC = readFileSync(new URL("docs/spec.md", ROOT), "utf8")

/** The scenario ids §18.2 lists, in the order the table gives them. */
function scenariosInSpec(): readonly string[] {
  const table = SPEC.slice(SPEC.indexOf("### 18.2"), SPEC.indexOf("## 19."))
  return [...table.matchAll(/^\| (S-\d+) \|/gm)].map(([, id]) => id as string)
}

const SCENARIOS = scenariosInSpec()

const TEST_DIRS = ["apps/api/test/", "apps/web/test/", "packages/shared/test/"] as const

function testFiles(): readonly { readonly name: string; readonly text: string }[] {
  return TEST_DIRS.flatMap((dir) => {
    const base = new URL(dir, ROOT)
    return readdirSync(base)
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => ({ name: `${dir}${name}`, text: readFileSync(new URL(name, base), "utf8") }))
  })
}

const FILES = testFiles()

/** Which files claim a scenario. This file itself is not a claim. */
function claimants(id: string): readonly string[] {
  const mention = new RegExp(`\\b${id}\\b`)
  return FILES.filter(
    (file) => !file.name.endsWith("scenario-coverage.test.ts") && mention.test(file.text),
  ).map((file) => file.name)
}

describe("§18.2 — the scenarios that block a merge", () => {
  it("read the table and the tests", () => {
    /*
     * The control. Every assertion below is derived, and a derived list that
     * comes back empty passes silently — a renamed heading would turn this
     * file green rather than red, which is exactly the failure it exists to
     * prevent.
     */
    expect(SCENARIOS.length, "no scenarios were parsed out of 18.2").toBeGreaterThanOrEqual(9)
    expect(FILES.length, "no test files were read").toBeGreaterThan(30)
  })

  it.each(SCENARIOS)("%s is claimed by at least one test", (id) => {
    /*
     * If this fails, either the scenario has no test — in which case 18.2 is
     * claiming a gate that does not exist — or it has one that does not say
     * so. Both are worth failing for, and the second is cheap to fix: put the
     * id in the test's name or its comment, where the next reader will find it.
     */
    expect(claimants(id), `${id} is in §18.2 but no test mentions it`).not.toEqual([])
  })

  it("has no test claiming a scenario the spec dropped", () => {
    /*
     * The other direction, which matters when a scenario is renumbered rather
     * than removed: a test still claiming S-4 after the table moved on is
     * evidence for a gate that is no longer specified, and reads as coverage.
     */
    const known = new Set(SCENARIOS)
    const orphans = new Set<string>()

    for (const file of FILES) {
      if (file.name.endsWith("scenario-coverage.test.ts")) continue
      for (const [, id] of file.text.matchAll(/\b(S-\d+)\b/g)) {
        if (id && !known.has(id)) orphans.add(`${id} (${file.name})`)
      }
    }

    expect([...orphans], "a test claims a scenario §18.2 does not list").toEqual([])
  })
})
