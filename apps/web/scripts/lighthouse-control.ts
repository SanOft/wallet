/**
 * Proves the Lighthouse budget can fail.
 *
 * Without this the budget job is theatre. A budget that cannot go red looks
 * exactly like one that is passing, and this repository has shipped six of
 * those — a rate limiter that rebuilt its store per request, five privilege
 * assertions that passed on a connection error, a contrast regex carrying a
 * literal backspace byte, a layer guard that stripped the strings it was meant
 * to read, a deploy monitor watching the wrong run, and a type guard with no
 * coverage that let money reach the treasury's phone number. Every one was
 * caught by a control like this one rather than by more coverage. It is the
 * third standing rule in docs/runbook.md §5.
 *
 * The method: make the build genuinely slow, in a way no reasonable change
 * would, then run the real budget — the same file, the same thresholds, the
 * same route — and require it to refuse. If it passes, the budget is not
 * measuring the build, and this exits non-zero saying so.
 *
 * A synchronous busy-wait in `<head>` is the chosen weight because it blocks
 * the parser before first paint, so it moves First Contentful Paint, Largest
 * Contentful Paint and Total Blocking Time at once. Lighthouse's mobile
 * throttling is simulated and multiplies observed CPU time, so the 600 ms here
 * lands as several seconds in the report — far outside the ceilings, which is
 * what a control wants. A control that only just fails is measuring luck.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const INDEX = join(WEB_ROOT, "dist", "index.html")
const BACKUP = join(WEB_ROOT, "dist", "index.html.control-backup")
const BUDGET = join(WEB_ROOT, "scripts", "lighthouse-budget.ts")

const BUSY_MS = 600

/**
 * Inserted verbatim, before `</head>`. Written without a regular expression on
 * purpose: `String.prototype.replace` with a string pattern replaces the first
 * occurrence and interprets no escapes, and a backslash through a regex is how
 * this repository has twice shipped a literal backspace byte.
 */
const WEIGHT = `<script>var end=Date.now()+${BUSY_MS};while(Date.now()<end){}</script>`

if (!existsSync(INDEX)) {
  console.error("lighthouse-control: no dist/index.html — build the web workspace first.")
  process.exit(1)
}

const original = readFileSync(INDEX, "utf8")
if (!original.includes("</head>")) {
  // Not "nothing to weigh down". If the shape changed, injecting nothing and
  // then watching the budget pass would report the control as satisfied while
  // it tested precisely nothing — the failure this file exists to prevent.
  console.error("lighthouse-control: no </head> in dist/index.html — did the build shape change?")
  process.exit(1)
}

copyFileSync(INDEX, BACKUP)

let status: number | null = null
try {
  writeFileSync(INDEX, original.replace("</head>", `${WEIGHT}</head>`))
  console.log(`lighthouse-control: injected a ${BUSY_MS} ms blocking script; running the budget.\n`)

  const result = spawnSync(process.execPath, ["--import", "tsx", BUDGET], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: WEB_ROOT,
  })
  status = result.status
} finally {
  copyFileSync(BACKUP, INDEX)
  rmSync(BACKUP, { force: true })
}

if (status === 0) {
  console.error(
    "\nlighthouse-control: THE BUDGET PASSED A BUILD THAT SHOULD HAVE BLOWN IT.\n\n" +
      `A ${BUSY_MS} ms synchronous script in <head> was added to dist/index.html and the\n` +
      "budget still reported green. Whatever it is measuring, it is not this build, so a\n" +
      "green result from it means nothing. Fix the budget before trusting the job again.",
  )
  process.exit(1)
}

console.log(
  `\nlighthouse-control: the budget refused the weighted build (exit ${status}), as it must.\n`,
)
