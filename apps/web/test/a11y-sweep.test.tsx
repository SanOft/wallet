import "fake-indexeddb/auto"

import { screen } from "@testing-library/react"
import axe from "axe-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearOutbox } from "../src/lib/outbox.js"
import { clearReadCache, resetReadCacheConnection } from "../src/lib/readCache.js"
import { renderSignedIn, renderSignedOut } from "./renderApp.js"

/**
 * Every screen through axe, not only the one that had a test.
 *
 * `home.test.tsx` and `shell.test.tsx` already run axe, and that was mistaken
 * for the feature being covered: the application has eight screens and axe saw
 * one of them plus the shell. The transfer wizard — four steps, three forms,
 * a live region and the only place money moves — had never been through it.
 *
 * This is a sweep rather than a per-screen assertion on purpose. What it is
 * good at is the class of defect that arrives by accident: a heading level
 * skipped, a control with no accessible name, a region without a label. What
 * it cannot do is judge whether the name a control has is the *right* one, and
 * §13.7's keyboard and screen-reader passes stay manual in `smoke-plan.md` §6
 * for that reason. An automated pass is a floor.
 */

/**
 * jsdom has no layout engine, so these two would report on a page with no
 * geometry. Contrast is computed from the stylesheet in `contrast.test.ts` and
 * touch size is asserted in `shell.test.tsx` — the same split `home.test.tsx`
 * already makes, repeated here rather than loosened.
 */
const WITHOUT_LAYOUT: axe.RunOptions = {
  resultTypes: ["violations"],
  rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
}

async function violationsIn(container: HTMLElement): Promise<readonly string[]> {
  const results = await axe.run(container, WITHOUT_LAYOUT)

  /*
   * The rule id and the element, not just the id. A bare list of ids sends the
   * reader hunting; axe already knows which node failed and saying so is the
   * difference between a report somebody acts on and one they re-run.
   */
  return results.violations.map(
    (violation) => `${violation.id} — ${violation.nodes[0]?.html?.slice(0, 80) ?? "?"}`,
  )
}

beforeEach(async () => {
  resetReadCacheConnection()
  await clearReadCache()
  await clearOutbox()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("every screen a signed-in person can reach", () => {
  it.each([
    { path: "/", waitsFor: /wallet/i },
    { path: "/transfer", waitsFor: /kimga/i },
    { path: "/history", waitsFor: /tarix|amaliyotlar/i },
    { path: "/profile", waitsFor: /profil/i },
    { path: "/labs/ussd", waitsFor: /ussd/i },
  ])(
    "$path has no violation axe can detect without layout",
    async ({ path, waitsFor }) => {
      window.history.pushState({}, "", path)

      const { container } = await renderSignedIn()
      /*
       * The screen's own `h1`, not a timer: a sweep that ran before the route
       * painted would audit the shell five times and pass.
       *
       * Scoped to level 1 because several screens repeat their name on a section
       * heading — `/history` has both `<h1>Tarix</h1>` and a labelled region —
       * and an unscoped query matches both and throws. That is the query being
       * wrong, not the page: exactly one `h1` per screen is the property being
       * relied on here.
       */
      await screen.findByRole("heading", { name: waitsFor, level: 1 })

      expect(await violationsIn(container)).toEqual([])
    },
    20_000,
  )
})

describe("the screens reachable without a session", () => {
  it.each([
    { path: "/login", waitsFor: /kirish/i },
    { path: "/register", waitsFor: /ro'yxatdan/i },
  ])(
    "$path has no violation axe can detect without layout",
    async ({ path, waitsFor }) => {
      window.history.pushState({}, "", path)

      const { container } = await renderSignedOut()
      await screen.findByRole("heading", { name: waitsFor, level: 1 })

      expect(await violationsIn(container)).toEqual([])
    },
    20_000,
  )
})

describe("the sweep itself", () => {
  it("audits a real page rather than an empty container", async () => {
    /*
     * The control. `axe.run` on a container with nothing in it reports no
     * violations, so every assertion above is satisfied by a render that
     * failed — which is the shape this file exists to avoid rather than
     * demonstrate.
     */
    window.history.pushState({}, "", "/")
    const { container } = await renderSignedIn()
    await screen.findByRole("heading", { name: /wallet/i, level: 1 })

    const audited = await axe.run(container, WITHOUT_LAYOUT)

    expect(audited.passes.length, "axe found nothing to check").toBeGreaterThan(5)
  }, 20_000)
})
