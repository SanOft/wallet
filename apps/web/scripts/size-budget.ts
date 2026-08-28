/**
 * Enforces the bundle budget the spec already states (docs/spec.md:227):
 * initial JS, gzipped, under 200 KB.
 *
 * The number was written down months ago and nothing measured it, which is the
 * failure mode a written budget invites — it reads as a decision while being an
 * intention. A budget that is not checked is discovered the day someone on a
 * slow connection cannot open the app, and by then the growth is spread across
 * fifty commits and nobody can name the one that cost it.
 *
 * *Initial* JS specifically, not everything in `dist`: a lazily-loaded route is
 * not paid for at first paint, and counting it would push us to inline chunks
 * to satisfy a number, making the real experience worse. So this follows what
 * the document actually loads — the entry module plus the `modulepreload` links
 * Vite emits for its static imports — and ignores the rest.
 *
 * No dependency: gzip is in Node, and a size check that needs a package to run
 * is one more thing to keep current.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist")

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
const BUDGET_BYTES = 200 * KB

function assetsIn(html: string): readonly string[] {
  const found = new Set<string>()

  // The entry, and the static imports the browser is told to fetch alongside
  // it. Both are paid for before the app is interactive.
  const patterns = [
    /<script[^>]+type="module"[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g,
  ]

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const href = match[1]
      if (href?.endsWith(".js")) found.add(href)
    }
  }

  return [...found]
}

function gzippedBytes(href: string): number {
  // Hrefs are absolute from the site root; `dist` is that root.
  return gzipSync(readFileSync(join(DIST, href.replace(/^\//, "")))).length
}

function format(bytes: number): string {
  return `${(bytes / KB).toFixed(2)} KB`
}

const html = readFileSync(join(DIST, "index.html"), "utf8")
const assets = assetsIn(html)

if (assets.length === 0) {
  // Not "the bundle is 0 KB". A parse that finds nothing means the build output
  // changed shape, and silently passing would retire this check without anyone
  // deciding to.
  console.error(
    "size-budget: found no entry script in dist/index.html — did the build shape change?",
  )
  process.exit(1)
}

const total = assets.reduce((sum, href) => sum + gzippedBytes(href), 0)

for (const href of assets) {
  console.log(`  ${href.padEnd(40)} ${format(gzippedBytes(href)).padStart(10)}`)
}
console.log(
  `  ${"initial JS (gzip)".padEnd(40)} ${format(total).padStart(10)}  of ${format(BUDGET_BYTES)}`,
)

if (total > BUDGET_BYTES) {
  console.error(
    `\nsize-budget: over budget by ${format(total - BUDGET_BYTES)}.\n` +
      "The budget is docs/spec.md:227. Raising it is a decision to make in the spec,\n" +
      "with the reason written down — not a number to edit here to get green.",
  )
  process.exit(1)
}

console.log(`  ${format(BUDGET_BYTES - total)} to spare.\n`)
