/**
 * Enforces the Lighthouse budget the spec states (docs/spec.md, NFR-2.1).
 *
 * The sibling of `size-budget.ts`, and it exists for the same reason. Four
 * category scores were written down in `docs/runbook.md` as a quality bar and
 * nothing measured them, which turns a decision into an intention: the day the
 * login screen gets slower, nobody finds out from CI, they find out from
 * somebody on a slow connection.
 *
 * Two things this deliberately does not do.
 *
 * It does not gate on the Performance score. That number is a weighted
 * log-normal curve, and above 0.96 a few milliseconds cost a whole point —
 * measured on this application, the mobile score flips between 97 and 98 on
 * about 140 ms of Largest Contentful Paint, which is less than one CI runner
 * differs from another. Gating on it would produce failures that are not
 * regressions, and a check that cries wolf gets disabled. The metrics
 * underneath have no such cliff, and when one trips it says which.
 *
 * It does not serve `dist` itself. `vite preview` is what the baseline was
 * measured against and it sets `Content-Encoding`; a hand-rolled static server
 * that forgets to would measure the harness rather than the application, which
 * this project has already done once — see docs/runbook.md, "Serve the build
 * the way a host would".
 *
 * The budget lives in the spec, not here. Raising a number in this file to get
 * green is the failure this file exists to prevent; raising it in the spec
 * costs a sentence saying why, which is the point.
 *
 * **Known: this does not run to completion on Windows.** Not because of
 * anything here — the bare `lighthouse` CLI fails identically, with no server
 * of ours involved. Once Chrome exits, `chrome-launcher` deletes the temporary
 * profile it created; Windows still holds a handle to it, and the `EPERM` from
 * that `rmSync` becomes the CLI's exit code. It skips the delete only when the
 * caller supplies its own `userDataDir`, which the Lighthouse CLI does not
 * expose (chrome-launcher/dist/chrome-launcher.js:357-367). The measurement
 * itself finishes and the report it writes is sound — a Windows run of this
 * file produced Performance 97, FCP 1992 ms, LCP 2118 ms, `runtimeError` null,
 * squarely inside the CI range — but the exit code says otherwise.
 *
 * A non-zero exit is deliberately still treated as a failure. Accepting one
 * because a report happened to appear is how a check stops being able to fail,
 * and that is the thing this job exists to prevent. Run it on Linux — which is
 * where CI runs it — or read the report artifact from the CI job.
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { preview } from "vite"
import { EXIT_CANNOT_MEASURE, EXIT_OVER_BUDGET } from "./lighthouse-exit-codes.ts"

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPORT_DIR = join(WEB_ROOT, "lighthouse-report")

/**
 * The route. `/login` is the only one a plain Lighthouse run can reach —
 * everything else is behind a session — and it is also the anonymous critical
 * path, so it is the one whose cost every first-time user pays.
 */
const ROUTE = "/login"

/**
 * Three runs, median taken. One run is a sample of a noisy process; the median
 * of three discards a single outlier, which is the shape the observed spread
 * has. Five would be steadier and roughly doubles the job.
 */
const RUNS = 3

/**
 * Fixed rather than ephemeral, and strict. A port already in use means some
 * other server would answer, and a budget measured against somebody else's
 * `dist` is worse than no budget at all — it is a green that means nothing.
 * Failing to bind is the correct outcome.
 */
const PORT = 4173

type FormFactor = "mobile" | "desktop"

/**
 * Lower is better for every metric, higher is better for every score. Both are
 * expressed as "the worst value still allowed", so one comparison direction
 * would be wrong for half the table — hence the explicit `kind`.
 */
type Limit = {
  readonly label: string
  readonly kind: "ceiling" | "floor"
  readonly unit: "ms" | "" | "score"
  readonly mobile: number
  readonly desktop: number
}

/**
 * docs/spec.md, NFR-2.1. Cited by section rather than by line: the line
 * citation in `size-budget.ts` has already drifted a line from the row it
 * names, which is what a line number in a comment does over time.
 */
const BUDGET: readonly Limit[] = [
  { label: "first-contentful-paint", kind: "ceiling", unit: "ms", mobile: 2200, desktop: 700 },
  { label: "largest-contentful-paint", kind: "ceiling", unit: "ms", mobile: 2400, desktop: 750 },
  { label: "total-blocking-time", kind: "ceiling", unit: "ms", mobile: 100, desktop: 100 },
  { label: "speed-index", kind: "ceiling", unit: "ms", mobile: 2300, desktop: 700 },
  { label: "cumulative-layout-shift", kind: "ceiling", unit: "", mobile: 0.02, desktop: 0.02 },
  { label: "performance", kind: "floor", unit: "score", mobile: 95, desktop: 99 },
  { label: "accessibility", kind: "floor", unit: "score", mobile: 100, desktop: 100 },
  { label: "best-practices", kind: "floor", unit: "score", mobile: 100, desktop: 100 },
  { label: "seo", kind: "floor", unit: "score", mobile: 100, desktop: 100 },
]

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const

type Report = {
  readonly lighthouseVersion: string
  readonly environment: { readonly hostUserAgent: string }
  readonly categories: Record<string, { readonly score: number | null }>
  readonly audits: Record<string, { readonly numericValue?: number }>
}

function lighthouseCli(): string {
  // `bin.lighthouse` in the package manifest. Resolved rather than assumed to
  // sit in `.bin`, because the layout there differs between package managers
  // and between platforms.
  return createRequire(import.meta.url).resolve("lighthouse/cli/index.js")
}

function chromeFlags(): string {
  const flags = ["--headless=new"]
  if (process.env.CI) {
    // The CI job runs as root inside a container, where Chrome's sandbox
    // cannot start, and the container's default /dev/shm is too small for it.
    // Neither is true on a developer machine, so neither is passed there.
    flags.push("--no-sandbox", "--disable-dev-shm-usage")
  }
  return flags.join(" ")
}

async function runLighthouse(url: string, form: FormFactor, run: number): Promise<Report> {
  const output = join(REPORT_DIR, `${form}-${run}.json`)
  const args = [
    lighthouseCli(),
    url,
    `--only-categories=${CATEGORIES.join(",")}`,
    `--chrome-flags=${chromeFlags()}`,
    "--output=json",
    `--output-path=${output}`,
    "--quiet",
  ]
  if (form === "desktop") args.push("--preset=desktop")

  /*
   * `spawn`, awaited — never `spawnSync`.
   *
   * The preview server above runs inside *this* process, so a synchronous
   * spawn blocks the event loop that serves it: Chrome asks for the page,
   * nothing answers, and ten minutes later Lighthouse gives up with
   * "Protocol error (Page.navigate): Target closed". That is what the first
   * version of this file did, and the failure looks like a browser problem
   * rather than like the deadlock it is.
   */
  const status = await new Promise<number | null>((settle, fail) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] })
    child.on("error", fail)
    child.on("close", settle)
  })

  if (status !== 0) {
    console.error(`\nlighthouse-budget: lighthouse exited ${status} on the ${form} run.`)
    console.error("This is a failure to measure, not a verdict on the build.")
    process.exit(EXIT_CANNOT_MEASURE)
  }

  return JSON.parse(readFileSync(output, "utf8")) as Report
}

/** The observed value for one budget row, from one report. */
function observed(report: Report, limit: Limit): number {
  if (limit.kind === "floor") {
    const score = report.categories[limit.label]?.score
    if (typeof score !== "number") {
      // A category that did not run scores `null`, and `null` compared against
      // a floor would sail through as 0 or as NaN depending on the operator.
      // Neither is a pass, and neither should look like one.
      console.error(`\nlighthouse-budget: category "${limit.label}" produced no score.`)
      process.exit(EXIT_CANNOT_MEASURE)
    }
    return Math.round(score * 100)
  }

  const value = report.audits[limit.label]?.numericValue
  if (typeof value !== "number") {
    console.error(`\nlighthouse-budget: audit "${limit.label}" produced no value.`)
    process.exit(EXIT_CANNOT_MEASURE)
  }
  return value
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted[Math.floor(sorted.length / 2)]
  if (middle === undefined) throw new Error("median of nothing")
  return middle
}

function format(value: number, unit: Limit["unit"]): string {
  if (unit === "ms") return `${Math.round(value)} ms`
  if (unit === "score") return String(Math.round(value))
  return value.toFixed(3)
}

const server = await preview({
  root: WEB_ROOT,
  preview: { port: PORT, strictPort: true },
  logLevel: "warn",
})

const url = `http://localhost:${PORT}${ROUTE}`
const failures: string[] = []

try {
  rmSync(REPORT_DIR, { recursive: true, force: true })
  mkdirSync(REPORT_DIR, { recursive: true })

  for (const form of ["mobile", "desktop"] as const) {
    const reports: Report[] = []
    for (let run = 1; run <= RUNS; run++) reports.push(await runLighthouse(url, form, run))

    const first = reports[0]
    if (first === undefined) throw new Error("no reports")
    console.log(
      `\n  ${form} — lighthouse ${first.lighthouseVersion}, ${first.environment.hostUserAgent}`,
    )

    for (const limit of BUDGET) {
      const samples = reports.map((report) => observed(report, limit))
      const value = median(samples)
      const allowed = limit[form]
      const over = limit.kind === "ceiling" ? value > allowed : value < allowed
      const spread = `${format(Math.min(...samples), limit.unit)}..${format(Math.max(...samples), limit.unit)}`

      console.log(
        `  ${over ? "FAIL" : "ok  "} ${limit.label.padEnd(26)}` +
          `${format(value, limit.unit).padStart(10)}` +
          `  ${limit.kind === "ceiling" ? "of" : "of at least"} ${format(allowed, limit.unit)}` +
          `   (n=${RUNS}, ${spread})`,
      )

      if (over) {
        failures.push(
          `${form} ${limit.label}: ${format(value, limit.unit)}, ` +
            `${limit.kind === "ceiling" ? "over the ceiling of" : "under the floor of"} ` +
            `${format(allowed, limit.unit)}`,
        )
      }
    }
  }
} finally {
  await server.close()
}

if (failures.length > 0) {
  console.error("\nlighthouse-budget: over budget.\n")
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    "\nThe budget is docs/spec.md, NFR-2.1. Raising it is a decision to make in the\n" +
      "spec, with the reason written down — not a number to edit here to get green.\n" +
      `The reports behind these figures are in ${REPORT_DIR}.`,
  )
  process.exit(EXIT_OVER_BUDGET)
}

console.log("\n  within budget on every metric and every category.\n")
