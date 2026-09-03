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

/**
 * The lines of one job's block, from `  <name>:` up to the next job.
 *
 * Lexical rather than parsed, for the same reason the rest of this file is: a
 * YAML parser would be a dependency in the production tree, and every rule
 * asserted here is about the literal text a reviewer reads.
 */
function job(file: string, name: string): string[] {
  const text = workflows().find((w) => w.name === file)?.text ?? ""
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.trimEnd() === `  ${name}:`)
  expect(start, `${file} has no job named ${name}`).toBeGreaterThanOrEqual(0)

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}[\w-]+:/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

/** A job's `if:` value on one line, folded blocks included. */
function condition(file: string, name: string): string {
  const lines = job(file, name)
  const start = lines.findIndex((line) => /^ {4}if:/.test(line))
  expect(start, `${file}: job ${name} has no if:`).toBeGreaterThanOrEqual(0)

  /*
   * The folded block ends at the next key *or comment* at the job's own
   * indentation. Stopping only at a key would fold the comments that follow
   * into the value, and then a comment naming a clause would satisfy the
   * assertions below without the clause existing.
   */
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {4}(#|[\w-]+:)/.test(line))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * One workflow's `on:` block, collapsed to a line, comments dropped.
 *
 * The comments go for the same reason `condition` stops folding at one: a
 * comment naming a trigger would otherwise satisfy an assertion about that
 * trigger existing.
 */
function triggers(file: string): string {
  const lines = (workflows().find((w) => w.name === file)?.text ?? "").split("\n")
  const start = lines.findIndex((line) => line.trimEnd() === "on:")
  expect(start, `${file} has no on: block`).toBeGreaterThanOrEqual(0)

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^[\w-]+:/.test(line))
  return flatten((end === -1 ? rest : rest.slice(0, end)).filter((l) => !l.trim().startsWith("#")))
}

const DEPENDABOT = fileURLToPath(new URL("../../../.github/dependabot.yml", import.meta.url))

/** The lines of one `- package-ecosystem: <name>` entry, up to the next one. */
function update(ecosystem: string): string[] {
  const lines = readFileSync(DEPENDABOT, "utf8").split("\n")
  const start = lines.findIndex((line) => line.trim() === `- package-ecosystem: ${ecosystem}`)
  expect(start, `dependabot.yml has no ${ecosystem} update entry`).toBeGreaterThanOrEqual(0)

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}- package-ecosystem:/.test(line))
  return lines.slice(start, end === -1 ? undefined : start + 1 + end)
}

/** An update entry collapsed to one line, so a value's own indentation cannot hide it. */
function flatten(lines: string[]): string {
  return lines.join(" ").replace(/\s+/g, " ").trim()
}

describe("the deploy workflow only runs code that is on main", () => {
  /*
   * F1. `on.workflow_run.branches` filters on the *head* branch of the run that
   * triggered this one, and a fork's default branch is called `main` too — so
   * that filter alone lets CI for a pull request from a fork start the deploy,
   * which checks out the fork's commit and runs its `.yarn/releases` binary
   * with the production database URL in the environment.
   *
   * The gate is the job-level `if` plus an ancestry proof taken before any code
   * from the triggering commit is on disk. Both halves are asserted, because
   * either one alone is a deploy that can be made to run attacker-authored
   * code.
   */
  it("gates migrate on a push to this repository's own main", () => {
    const gate = condition("deploy.yml", "migrate")

    expect(gate, "a red CI run must not deploy").toContain(
      "github.event.workflow_run.conclusion == 'success'",
    )
    // Without this clause a pull_request-triggered CI run reaches the job.
    expect(gate, "a pull request must not deploy").toContain(
      "github.event.workflow_run.event == 'push'",
    )
    expect(gate, "only main deploys").toContain("github.event.workflow_run.head_branch == 'main'")
    // Without this clause a fork's own `main` satisfies the branch clause.
    expect(gate, "only this repository deploys").toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    )
  })

  it("proves the commit is on main before running anything from it", () => {
    // Both jobs check out `head_sha`; both must earn it first.
    for (const name of ["migrate", "smoke"]) {
      const lines = job("deploy.yml", name)
      const check = lines.findIndex((line) => line.includes("git merge-base --is-ancestor"))
      expect(check, `deploy.yml: job ${name} never proves the commit is on main`).toBeGreaterThan(0)

      const before = lines.slice(0, check)
      expect(
        before.join("\n"),
        `deploy.yml: job ${name} must check out main with full history first`,
      ).toContain("ref: main")
      expect(before.join("\n"), `deploy.yml: job ${name} needs history to walk`).toContain(
        "fetch-depth: 0",
      )

      /*
       * `yarn install` runs the checkout's own `.yarn/releases/*.cjs` — see
       * `.yarnrc.yml` — so an install before the ancestry check is already
       * arbitrary code execution, whatever the later steps do.
       */
      for (const line of before) {
        if (line.trim().startsWith("#")) continue
        expect(
          line,
          `deploy.yml: job ${name} runs project tooling before the ancestry check`,
        ).not.toMatch(/\b(yarn|corepack)\b/)
      }
    }
  })

  it("puts every job that holds a production secret in the production environment", () => {
    /*
     * Defence in depth behind the `if`, and the only place a deploy's history
     * is visible as a list. It also gives the secrets one scope to be revoked
     * from, rather than the whole repository.
     */
    for (const name of ["migrate", "release", "smoke"]) {
      expect(
        job("deploy.yml", name).map((l) => l.trim()),
        `deploy.yml: job ${name}`,
      ).toContain("environment: production")
    }
  })
})

describe("the ledger is reconciled on a schedule, not on request", () => {
  /*
   * §20.4 asks for a *daily* reconciliation. `db:reconcile` has been runnable
   * since day 5 and nothing ran it, which is the same shape as the function
   * nothing called that the command replaced: a control that has to be
   * remembered is not a control.
   *
   * This file is the whole mechanism — `schedule` fires only on the default
   * branch and there is no scheduler outside the repository to check against —
   * so the cron is asserted here rather than trusted to a settings page.
   */
  it("fires daily on a cron and can still be run by hand", () => {
    const on = triggers("reconcile.yml")

    expect(on, "without the cron nothing calls db:reconcile").toContain('cron: "17 3 * * *"')
    // The run somebody needs after a repair, when "is it clean now?" cannot
    // wait until tomorrow.
    expect(on, "an operator must be able to ask for a run").toContain("workflow_dispatch:")
  })

  it("runs the command itself, against the production database", () => {
    const block = flatten(
      job("reconcile.yml", "reconcile").filter((l) => !l.trim().startsWith("#")),
    )

    // The same scoping deploy.yml uses: one place to revoke the connection
    // string from, rather than the whole repository.
    expect(block, "the database URL must be an environment secret").toContain(
      "environment: production",
    )
    expect(block, "must run the workspace command, not a copy of the query").toContain(
      "yarn workspace @wallet/api db:reconcile",
    )
    // A pattern rather than a literal only because `${{` inside a TypeScript
    // string is itself a lint error here; the text matched is exact.
    expect(block, "the job has nothing to read without it").toMatch(
      /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/,
    )
  })

  it("lets a discrepancy fail the run", () => {
    /*
     * The alarm is the exit status: `runReconciliation` exits 1 on a drift, a
     * chain break or a non-zero global sum, and a failed *scheduled* run is
     * what emails the owner. `continue-on-error`, or a `|| true` on the step,
     * turns the nightly alarm back into a log line nobody reads.
     */
    for (const line of job("reconcile.yml", "reconcile")) {
      if (line.trim().startsWith("#")) continue
      expect(line, `reconcile.yml swallows a failure: ${line.trim()}`).not.toMatch(
        /continue-on-error|\|\| true/,
      )
    }
  })
})

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

describe("dependabot covers the npm workspace too", () => {
  /*
   * T14. The workflow updater above only ever sees `actions/checkout` and its
   * neighbours; every dependency the application itself runs on — Prisma,
   * React, the rest of `package.json` — has no updater at all without this
   * entry.
   */
  it("watches the workspace root weekly with a bounded review queue", () => {
    const block = flatten(update("npm"))
    expect(block, "must scan the workspace root, where the lockfile lives").toContain(
      "directory: /",
    )
    expect(block, "must check for updates weekly").toContain("schedule: interval: weekly")
    // Same reasoning as the github-actions updater: an unbounded queue of pull
    // requests is as unread as no updater at all.
    expect(block, "must cap open pull requests at 5").toContain("open-pull-requests-limit: 5")
  })

  it("groups minor and patch bumps into one weekly pull request", () => {
    const block = flatten(update("npm"))
    expect(block, "minor and patch bumps must land in one reviewable group").toContain(
      "groups: minor-and-patch: update-types: - minor - patch",
    )
  })

  it("leaves prisma, react and vite majors for a deliberate upgrade", () => {
    const block = flatten(update("npm"))
    // Each of these majors is a decision (a schema migration, a rendering
    // change, a build-pipeline change), not something a grouped, unread bump
    // should ever carry through.
    for (const name of ["prisma", '"@prisma/*"', "react", "react-dom", "vite"]) {
      expect(block, `${name} must be excluded from automatic major bumps`).toContain(
        `dependency-name: ${name} update-types: - version-update:semver-major`,
      )
    }
  })
})
