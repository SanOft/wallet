/**
 * Proves the size budget can fail — both halves of it, separately.
 *
 * `size-budget.ts` holds two different things about the stylesheet: a ceiling,
 * which catches gross growth, and a committed baseline, which catches any
 * growth at all. They fail for different reasons and either can rot without the
 * other, so each gets its own probe. One probe covering both would pass
 * whenever either happened to fire, which is how a control ends up proving the
 * easy half.
 *
 * The sensitive probe adds **one byte**. That is exactly the claim the baseline
 * makes — that a deterministic artefact needs no margin — and a control that
 * added a comfortable kilobyte would test something weaker than what is
 * written down. F7's regression, the one this mechanism exists for, was 60
 * bytes.
 *
 * The ceiling probe moves the baseline with it, on purpose. Padding the
 * stylesheet breaks the baseline too, so without that the second probe would
 * only be re-proving the first. Aligning the baseline leaves the ceiling as the
 * only thing that can refuse, which is the point of running it.
 *
 * Without this the budget is theatre. A budget that cannot go red looks exactly
 * like one that is passing, and this repository has shipped six of those, every
 * one caught by a control rather than by more coverage. It is the third
 * standing rule in docs/runbook.md §5.
 *
 * Cheap, because bytes on disk have no noise: no rebuild, no browser, about a
 * second in total.
 */

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { EXIT_OVER_BUDGET } from "./budget-exit-codes.ts"

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = join(WEB_ROOT, "dist")
const BUDGET = join(WEB_ROOT, "scripts", "size-budget.ts")
const BASELINE = join(WEB_ROOT, "render-blocking-css.json")

/** Enough to clear the 4.5 KB gzipped ceiling from a stylesheet under 4 KB. */
const HEAVY_BYTES = 64 * 1024

function stylesheetPath(): string {
  const document = readFileSync(join(DIST, "index.html"), "utf8")
  const href = document.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1]
  if (href === undefined) {
    // Not "nothing to weigh down". If the build shape changed, padding nothing
    // and then watching the budget pass would report this control satisfied
    // while it tested precisely nothing — the failure it exists to prevent.
    console.error("size-control: no render-blocking stylesheet in dist/index.html.")
    process.exit(1)
  }
  return join(DIST, href.replace(/^\//, ""))
}

/**
 * `count` bytes that are still valid CSS.
 *
 * Trailing whitespace for the very small sizes, because a CSS comment cannot be
 * shorter than four bytes. Random hex inside a comment for the large one:
 * whitespace would compress to almost nothing and never reach a gzipped
 * ceiling, which would make the ceiling probe pass without testing it.
 */
function filler(count: number): string {
  if (count < 4) return " ".repeat(count)
  const body = count - 4
  return `/*${randomBytes(body).toString("hex").slice(0, body)}*/`
}

function runBudget(): number | null {
  const result = spawnSync(process.execPath, ["--import", "tsx", BUDGET], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: WEB_ROOT,
  })
  return result.status
}

type Probe = {
  readonly name: string
  readonly padding: number
  /** Rewrite the baseline to match the padded file, so only the ceiling can refuse. */
  readonly alignBaseline: boolean
}

function probe({ name, padding, alignBaseline }: Probe): void {
  const css = stylesheetPath()
  const cssBackup = `${css}.control-backup`
  const baselineBackup = `${BASELINE}.control-backup`

  copyFileSync(css, cssBackup)
  copyFileSync(BASELINE, baselineBackup)

  let status: number | null = null
  try {
    writeFileSync(css, readFileSync(css, "utf8") + filler(padding))

    if (alignBaseline) {
      const parsed: Record<string, unknown> = JSON.parse(readFileSync(BASELINE, "utf8"))
      parsed.renderBlockingCssRawBytes = statSync(css).size
      writeFileSync(BASELINE, `${JSON.stringify(parsed, null, 2)}\n`)
    }

    console.log(`\nsize-control: ${name} — added ${padding} bytes, running the budget.\n`)
    status = runBudget()
  } finally {
    copyFileSync(cssBackup, css)
    copyFileSync(baselineBackup, BASELINE)
    rmSync(cssBackup, { force: true })
    rmSync(baselineBackup, { force: true })
  }

  if (status === 0) {
    console.error(
      `\nsize-control: THE BUDGET PASSED A STYLESHEET ${padding} BYTES LARGER THAN THE ONE\n` +
        "IT IS SUPPOSED TO BE MEASURING.\n\n" +
        "Whatever it is checking, it is not this build, so a green result from it means\n" +
        "nothing. Fix the budget before trusting it again.",
    )
    process.exit(1)
  }

  if (status !== EXIT_OVER_BUDGET) {
    // Any non-zero exit would not do. A crash is non-zero too, and a control
    // that cannot tell "refused" from "broke" reports success when the check
    // has stopped working — which is how the Lighthouse control passed on its
    // first run in CI while proving nothing.
    console.error(
      `\nsize-control: the budget exited ${status}, not ${EXIT_OVER_BUDGET}.\n\n` +
        "That is the code for a failure to measure, not for a build over budget, so the\n" +
        "padded stylesheet was never actually judged and this run proves nothing.",
    )
    process.exit(1)
  }

  console.log(`size-control: ${name} — refused with exit ${status}, as it must.`)
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error("size-control: no dist/index.html — build the web workspace first.")
  process.exit(1)
}

probe({ name: "the baseline sees a single byte", padding: 1, alignBaseline: false })
probe({ name: "the ceiling sees gross growth", padding: HEAVY_BYTES, alignBaseline: true })

console.log("\nsize-control: both halves of the size budget refuse a build that should fail.\n")
