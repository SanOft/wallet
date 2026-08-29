/**
 * @vitest-environment node
 *
 * Reads the workflow files from disk. Nothing here touches a DOM.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The supply chain of the thing that builds this repository (P-5, P-3).
 *
 * OWASP's 2025 A03 is Software Supply Chain Failures, and a workflow is the
 * softest part of one: it runs on every pull request, holds a token, reads
 * every file, and — in `deploy.yml` — carries the production database URL and
 * the deploy hook.
 *
 * A tag is a mutable pointer somebody else controls. `actions/checkout@v7` is
 * whatever that tag points at when the job starts, and moving it is a supported
 * operation for the owner of that repository. Pinning by commit SHA is the only
 * form that says what will actually run.
 *
 * Asserted here rather than trusted to review because this is precisely the
 * kind of thing that regresses invisibly: the next person adding a step copies
 * `@v4` from the action's README, the workflow keeps working, and nothing
 * mentions it again.
 */

const WORKFLOWS = fileURLToPath(new URL("../../../.github/workflows", import.meta.url))

function workflows(): { name: string; text: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8") }))
}

/** Every `uses:` line, with its file, so a failure names the offender. */
function uses(): { file: string; line: string }[] {
  return workflows().flatMap(({ name, text }) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- uses:") || line.startsWith("uses:"))
      .map((line) => ({ file: name, line })),
  )
}

describe("the workflows' supply chain", () => {
  it("finds workflows at all", () => {
    // Without this, a rename of the directory turns every assertion below into
    // a vacuous pass over an empty array — which is the failure mode of every
    // lexical rule in this repository.
    const found = workflows().map((w) => w.name)
    expect(found).toContain("ci.yml")
    expect(found).toContain("deploy.yml")
    expect(uses().length).toBeGreaterThan(3)
  })

  it("pins every action by commit SHA, never by tag", () => {
    for (const { file, line } of uses()) {
      /*
       * Forty hex characters. `@v7` and `@main` both fail; `@<sha> # v7`
       * passes, and the comment is what a reader can actually check at a
       * glance — Dependabot rewrites both together.
       */
      expect(line, `${file}: ${line}`).toMatch(/uses:\s*[\w-]+\/[\w.-]+@[0-9a-f]{40}\b/)
    }
  })

  it("pins container images by digest, never by tag", () => {
    // P-3. `postgres:17-alpine` moves, so a run that was green in August is not
    // reproducible in December — and the CHECK constraints and triggers this
    // suite leans on are the database's behaviour, not ours.
    for (const { name, text } of workflows()) {
      for (const line of text.split("\n")) {
        const image = /^\s*image:\s*(\S+)/.exec(line)
        if (!image?.[1]) continue
        expect(image[1], `${name}: ${line.trim()}`).toContain("@sha256:")
      }
    }
  })

  it("declares read-only permissions rather than inheriting them", () => {
    /*
     * A repository's default can be write, which would hand every third-party
     * action in these files a token that can push to `main`. Neither workflow
     * needs to write anything.
     */
    for (const { name, text } of workflows()) {
      expect(text, `${name} has no permissions block`).toMatch(/^permissions:/m)
      expect(text, `${name} grants more than read`).toMatch(
        /^permissions:\s*\n\s+contents:\s*read/m,
      )
    }
  })

  it("bounds every job, so a hang cannot hold a runner for six hours", () => {
    /*
     * Six hours is the default, and a hung job is not a rare event — it is what
     * a deadlocked Postgres client looks like from the outside.
     *
     * The job names are read out of the `jobs:` block rather than by matching
     * indentation, which was the first version: that counted `pull_request:`
     * and `push:` under `on:` as jobs and reported four where there are two.
     */
    for (const { name, text } of workflows()) {
      const lines = text.split("\n")
      const start = lines.findIndex((line) => line.trimEnd() === "jobs:")
      expect(start, `${name} has no jobs block`).toBeGreaterThanOrEqual(0)

      const jobs = lines
        .slice(start + 1)
        .filter((line) => /^ {2}[\w-]+:\s*$/.test(line))
        .map((line) => line.trim().replace(":", ""))

      const timeouts = lines.filter((line) => line.trim().startsWith("timeout-minutes:")).length
      expect(
        timeouts,
        `${name}: ${jobs.length} jobs (${jobs.join(", ")}) but ${timeouts} timeouts`,
      ).toBeGreaterThanOrEqual(jobs.length)
    }
  })

  it("still offers the check name branch protection requires", () => {
    /*
     * `main` requires a status check named exactly `verify`. That rule lives in
     * the repository settings, where nothing here can read it — so this is the
     * repository's half of the contract.
     *
     * It is not hypothetical. Splitting `verify` into a Node matrix renamed its
     * checks to `verify (22)` and `verify (24)`, the required `verify` stopped
     * reporting, and every pull request became permanently unmergeable. It was
     * caught because a pull request sat at BLOCKED with three green jobs.
     * `verify` is now an aggregate over the others, so the matrix can change
     * without touching a setting nobody can see from here.
     */
    const ci = workflows().find((w) => w.name === "ci.yml")
    expect(ci).toBeDefined()

    const lines = (ci?.text ?? "").split("\n")
    const start = lines.findIndex((line) => line.trimEnd() === "jobs:")
    const jobs = lines
      .slice(start + 1)
      .filter((line) => /^ {2}[\w-]+:\s*$/.test(line))
      .map((line) => line.trim().replace(":", ""))

    expect(jobs, "branch protection requires a job named verify").toContain("verify")
  })

  it("keeps the pins from rotting", () => {
    /*
     * A pin without an updater is a freeze: the workflow runs whatever
     * `actions/checkout` looked like the day somebody pasted the hash,
     * vulnerabilities included, and nothing ever says so. This is the half that
     * makes the `# v7` comments trustworthy rather than decorative.
     */
    const config = readFileSync(
      fileURLToPath(new URL("../../../.github/dependabot.yml", import.meta.url)),
      "utf8",
    )
    expect(config).toContain("github-actions")
  })
})
