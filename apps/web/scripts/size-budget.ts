/**
 * Enforces the bundle budgets the spec already states (docs/spec.md, NFR-2 and
 * NFR-2.1): initial JS under 200 KB gzipped, and the render-blocking stylesheet
 * under 4.5 KB gzipped and byte-identical to a committed baseline.
 *
 * The numbers were written down months ago and nothing measured them, which is
 * the failure mode a written budget invites — it reads as a decision while
 * being an intention. A budget that is not checked is discovered the day
 * someone on a slow connection cannot open the app, and by then the growth is
 * spread across fifty commits and nobody can name the one that cost it.
 *
 * *Initial* JS specifically, not everything in `dist`: a lazily-loaded route is
 * not paid for at first paint, and counting it would push us to inline chunks
 * to satisfy a number, making the real experience worse. So this follows what
 * the document actually loads — the entry module plus the `modulepreload` links
 * Vite emits for its static imports, and the stylesheet the browser blocks
 * rendering on — and ignores the rest.
 *
 * No dependency: gzip is in Node, and a size check that needs a package to run
 * is one more thing to keep current.
 *
 * ## Why the stylesheet gets a baseline and the JS does not
 *
 * A ceiling only catches a regression bigger than its own slack, and the
 * stylesheet regression this project actually had was tiny. Tailwind emits one
 * stylesheet for the whole application, so a route behind `lazy()` can still
 * put its utilities in the CSS the login screen blocks on — F7 did exactly
 * that, and Lighthouse mobile performance fell a point (docs/runbook.md, "A
 * code-split route is not style-split"). Rebuilt with today's toolchain, F7's
 * source adds **60 raw bytes** to the emitted stylesheet. No ceiling with
 * useful slack sees 60 bytes.
 *
 * Nothing has to see it, though, because the stylesheet is a deterministic
 * artefact: same source, same bytes, every time. So the size is committed, and
 * any change to it is a change to a tracked file — 60 bytes of new
 * render-blocking CSS turns up in the diff next to the route that added it,
 * which is the conversation the runbook says to have. That is a snapshot, not
 * a threshold, and it needs no margin because there is no noise to leave room
 * for.
 *
 * The baseline is on **raw** bytes, not gzipped. Raw is the file on disk and is
 * identical everywhere; gzipped size depends on the zlib the build ran against,
 * and this repository builds on both Node 22 and Node 24. Gzip is what the
 * ceilings use, where the slack absorbs that difference.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { EXIT_CANNOT_MEASURE, EXIT_OVER_BUDGET } from "./budget-exit-codes.ts"

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = join(WEB_ROOT, "dist")
const BASELINE = join(WEB_ROOT, "render-blocking-css.json")

/**
 * KB as 1024 bytes, measured by gzipping the file on disk at Node's default
 * level — which is what a browser downloads.
 *
 * Vite's build line reports a slightly larger figure (124.33 vs 120.18 for the
 * same chunk) because it counts kB as 1000 bytes and compresses its own
 * in-memory buffer. Neither is wrong; they answer different questions. This one
 * is the budget, so it is stated here rather than inferred from build output.
 */
const KB = 1024
const JS_BUDGET_BYTES = 200 * KB
const CSS_BUDGET_BYTES = Math.round(4.5 * KB)

type Baseline = { readonly renderBlockingCssRawBytes: number }

function fail(message: string, code: number): never {
  console.error(`\nsize-budget: ${message}`)
  process.exit(code)
}

function html(): string {
  return readFileSync(join(DIST, "index.html"), "utf8")
}

function scriptsIn(document: string): readonly string[] {
  const found = new Set<string>()

  // The entry, and the static imports the browser is told to fetch alongside
  // it. Both are paid for before the app is interactive.
  const patterns = [
    /<script[^>]+type="module"[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g,
  ]

  for (const pattern of patterns) {
    for (const match of document.matchAll(pattern)) {
      const href = match[1]
      if (href?.endsWith(".js")) found.add(href)
    }
  }

  return [...found]
}

/**
 * The stylesheets the browser blocks the first paint on.
 *
 * A `media` attribute is how a stylesheet stops being render-blocking, so one
 * carrying it is deliberately excluded rather than silently counted — and
 * noted, because a stylesheet that leaves this set changes what the baseline
 * below means.
 */
function blockingStylesheetsIn(document: string): readonly string[] {
  const found = new Set<string>()

  for (const match of document.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)) {
    const tag = match[0]
    const href = tag.match(/href="([^"]+)"/)?.[1]
    if (href === undefined) continue
    if (/\smedia=/.test(tag)) {
      console.log(`  (not counted, has a media attribute: ${href})`)
      continue
    }
    found.add(href)
  }

  return [...found]
}

function bytesOf(href: string): { raw: number; gzip: number } {
  // Hrefs are absolute from the site root; `dist` is that root.
  const file = readFileSync(join(DIST, href.replace(/^\//, "")))
  return { raw: file.length, gzip: gzipSync(file).length }
}

function format(bytes: number): string {
  return `${(bytes / KB).toFixed(2)} KB`
}

/**
 * Nothing in this repository writes the baseline. It is updated by hand, in
 * the commit that moves the stylesheet, which is the entire mechanism — a
 * script that rewrote it would turn every regression into a silently accepted
 * one, and the file would document history rather than gate it.
 */
function readBaseline(): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE, "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "renderBlockingCssRawBytes" in parsed &&
      typeof parsed.renderBlockingCssRawBytes === "number"
    ) {
      return { renderBlockingCssRawBytes: parsed.renderBlockingCssRawBytes }
    }
  } catch {
    // Falls through to the same refusal: an unreadable baseline and a
    // malformed one are both "there is nothing to compare against".
  }
  return fail(
    `could not read a number from ${BASELINE}.\n` +
      "Without it there is nothing to compare the stylesheet against, and a check\n" +
      "that compares against nothing passes against anything.",
    EXIT_CANNOT_MEASURE,
  )
}

const document = html()
const scripts = scriptsIn(document)
const stylesheets = blockingStylesheetsIn(document)

if (scripts.length === 0) {
  // Not "the bundle is 0 KB". A parse that finds nothing means the build output
  // changed shape, and silently passing would retire this check without anyone
  // deciding to.
  fail(
    "found no entry script in dist/index.html — did the build shape change?",
    EXIT_CANNOT_MEASURE,
  )
}

if (stylesheets.length === 0) {
  fail(
    "found no render-blocking stylesheet in dist/index.html — did the build shape change?",
    EXIT_CANNOT_MEASURE,
  )
}

const jsTotal = scripts.reduce((sum, href) => sum + bytesOf(href).gzip, 0)
const css = stylesheets.reduce(
  (sum, href) => {
    const { raw, gzip } = bytesOf(href)
    return { raw: sum.raw + raw, gzip: sum.gzip + gzip }
  },
  { raw: 0, gzip: 0 },
)

for (const href of scripts) {
  console.log(`  ${href.padEnd(40)} ${format(bytesOf(href).gzip).padStart(10)}`)
}
console.log(
  `  ${"initial JS (gzip)".padEnd(40)} ${format(jsTotal).padStart(10)}  of ${format(JS_BUDGET_BYTES)}`,
)
console.log(
  `  ${"render-blocking CSS (gzip)".padEnd(40)} ${format(css.gzip).padStart(10)}  of ${format(CSS_BUDGET_BYTES)}`,
)

const failures: string[] = []

if (jsTotal > JS_BUDGET_BYTES) {
  failures.push(
    `initial JS is over budget by ${format(jsTotal - JS_BUDGET_BYTES)}. ` +
      "The budget is docs/spec.md, NFR-2.",
  )
}

if (css.gzip > CSS_BUDGET_BYTES) {
  failures.push(
    `render-blocking CSS is over budget by ${format(css.gzip - CSS_BUDGET_BYTES)}. ` +
      "The budget is docs/spec.md, NFR-2.1.",
  )
}

const baseline = readBaseline()
if (css.raw !== baseline.renderBlockingCssRawBytes) {
  const delta = css.raw - baseline.renderBlockingCssRawBytes
  const direction = delta > 0 ? "grew" : "shrank"
  failures.push(
    `render-blocking CSS ${direction} by ${Math.abs(delta)} raw bytes ` +
      `(${baseline.renderBlockingCssRawBytes} -> ${css.raw}).\n` +
      `    Tailwind emits one stylesheet for the whole application, so a route behind\n` +
      "    lazy() can still put its utilities in the CSS the login screen blocks on.\n" +
      "    That is not forbidden, it is a cost — write the new number into\n" +
      `    ${BASELINE} in this commit so the diff carries it, or move the styles\n` +
      "    into the route's own chunk as an inline style. docs/runbook.md, \"A\n" +
      '    code-split route is not style-split", says which to prefer and why.',
  )
}

if (failures.length > 0) {
  console.error("\nsize-budget: over budget.\n")
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    "\nRaising a ceiling is a decision to make in the spec, with the reason written\n" +
      "down — not a number to edit here to get green.",
  )
  process.exit(EXIT_OVER_BUDGET)
}

console.log(
  `  ${format(JS_BUDGET_BYTES - jsTotal)} of JS and ${format(CSS_BUDGET_BYTES - css.gzip)} of CSS to spare,` +
    ` stylesheet unchanged at ${css.raw} raw bytes.\n`,
)
