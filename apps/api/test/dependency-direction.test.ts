/**
 * @vitest-environment node
 *
 * Reads `biome.json` from disk. Nothing here touches a DOM.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * §8.2's dependency direction, as a rule rather than as a plan (P-10).
 *
 * The spec states it plainly — `packages/shared` imports nothing, `apps/*`
 * import only `packages/*`, and `apps/*` never import each other — and until
 * now added that it "is currently held by review rather than by a rule". This
 * file is here because the wiring itself has a failure mode that review has no
 * chance against: a `noRestrictedImports` group that matches nothing looks
 * exactly like one that works.
 *
 * That is not hypothetical. The first version used `**​/apps/api/**` alone, and
 * it does not match `../../api/src/domain/AuthService.js` — the relative escape
 * anyone reaching across workspaces would actually write. `tsc` compiles that
 * import without complaint, so nothing at all would have caught it. Both forms
 * are asserted below for that reason.
 *
 * It was written in `packages/shared` first, on the grounds that that is the
 * package whose isolation this protects most strictly. `tsc` refused it: shared
 * has no `@types/node`, because it has to run in a browser as well. So the rule
 * under test decided where its own test may live — which is the most direct
 * evidence available that the direction is real rather than aspirational.
 */

interface BiomeConfig {
  readonly overrides?: readonly {
    readonly includes: readonly string[]
    readonly linter?: {
      readonly rules?: {
        readonly style?: {
          readonly noRestrictedImports?: {
            readonly level?: string
            readonly options?: { readonly patterns?: readonly { readonly group?: string[] }[] }
          }
        }
      }
    }
  }[]
}

const CONFIG: BiomeConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../biome.json", import.meta.url)), "utf8"),
)

function groupFor(directory: string): readonly string[] {
  const override = CONFIG.overrides?.find((o) => o.includes.includes(directory))
  expect(override, `no override for ${directory}`).toBeDefined()

  const rule = override?.linter?.rules?.style?.noRestrictedImports
  // A warning is a rule nobody has to obey; CI only fails on errors.
  expect(rule?.level, `${directory} restriction is not an error`).toBe("error")

  return rule?.options?.patterns?.[0]?.group ?? []
}

describe("§8.2's dependency direction is enforced, not just described", () => {
  it("forbids the apps to import each other, by name and by path", () => {
    /*
     * Three forms per target, and dropping any one of them reopens a hole:
     * the package name is what somebody would write on purpose, `apps/<x>/**`
     * catches a full path, and `<x>/src/**` is the only one that catches a
     * relative escape — measured against Biome 2.5.10 rather than assumed.
     */
    for (const [directory, forbidden] of [
      ["apps/web/**", "api"],
      ["apps/api/**", "web"],
    ] as const) {
      const group = groupFor(directory)
      expect(group, directory).toContain(`@wallet/${forbidden}`)
      expect(group, directory).toContain(`**/apps/${forbidden}/**`)
      expect(group, `${directory} would miss a relative escape`).toContain(`**/${forbidden}/src/**`)
    }
  })

  it("forbids the contract package from importing either app", () => {
    // The direction, not merely the separation: `packages/shared` needing one
    // of its own consumers in order to build is the cycle §8.2 exists to stop.
    const group = groupFor("packages/shared/**")
    for (const app of ["api", "web"]) {
      expect(group).toContain(`@wallet/${app}`)
      expect(group).toContain(`**/${app}/src/**`)
    }
  })

  it("says why, so the diagnostic is actionable", () => {
    /*
     * A restricted-import error that only says "restricted" sends the reader
     * to this config to find out what they should have done instead. Each
     * message names the spec section and the answer: put it in
     * `packages/shared`.
     */
    for (const directory of ["apps/web/**", "apps/api/**", "packages/shared/**"]) {
      const override = CONFIG.overrides?.find((o) => o.includes.includes(directory))
      const pattern = override?.linter?.rules?.style?.noRestrictedImports?.options?.patterns?.[0]
      const message = (pattern as { message?: string } | undefined)?.message ?? ""

      expect(message, directory).toContain("8.2")
      expect(message.length, `${directory} message is too terse to act on`).toBeGreaterThan(60)
    }
  })
})
