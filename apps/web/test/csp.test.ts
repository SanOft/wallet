/**
 * @vitest-environment node
 *
 * Reads `vercel.json` from disk; nothing here touches a DOM.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The document origin's Content-Security-Policy (P-23).
 *
 * §17.1 answers "token theft via XSS" with "CSP (helmet)". Helmet runs on the
 * API and sets `default-src 'none'`, which is right for something that serves
 * no documents and is **not this mitigation**: the access token lives in
 * memory on the web origin (FR-2.4), which is a different registrable domain,
 * and a policy on one constrains nothing that can reach a variable on the
 * other. Until this file existed the control the threat model claimed was
 * deployed on the wrong host.
 *
 * The policy is in `vercel.json`, which takes no comments, so the reasoning is
 * here — where somebody about to weaken it will be sent by a failing test
 * rather than by a code review that may not happen.
 *
 * **Why there is no `'unsafe-inline'`, despite the inline styles.** Almost
 * every component in this codebase sets `style={{ ... }}`, because §13.2 bans
 * raw values and tokens are reached through `var()`. That looks like it forces
 * `style-src 'unsafe-inline'`, and it does not: React writes those through
 * CSSOM, and CSP governs the *parser* — an attribute produced by
 * `element.style.setProperty` is not an attribute the parser saw. Verified
 * against the real bundle rather than assumed: served behind this exact policy,
 * the login screen, the home screen and the USSD lab all render with their
 * inline styles applied and report no violations.
 */

const DOCUMENT_HEADERS: Readonly<Record<string, string>> = (() => {
  const path = fileURLToPath(new URL("../vercel.json", import.meta.url))
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }

  const entry = config.headers.find((h) =>
    h.headers.some((header) => header.key === "Content-Security-Policy"),
  )
  if (!entry) throw new Error("no Content-Security-Policy in vercel.json")

  // The document origin, not the API: the API sets its own through helmet, and
  // two policies on one response is a merge nobody intended.
  expect(entry.source).toBe("/((?!api/).*)")

  return Object.fromEntries(entry.headers.map((h) => [h.key, h.value]))
})()

const POLICY: string = DOCUMENT_HEADERS["Content-Security-Policy"] ?? ""

function directive(name: string): string | undefined {
  return POLICY.split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
}

describe("the document origin's CSP (P-23)", () => {
  it("denies by default, so a directive nobody thought of is closed", () => {
    expect(directive("default-src")).toBe("default-src 'none'")
  })

  it("allows no inline script or style, and no eval", () => {
    /*
     * The assertions that matter most, and the ones most likely to be
     * "temporarily" relaxed. `'unsafe-inline'` on script-src returns the
     * policy to doing nothing about the threat it is here for; on style-src it
     * is unnecessary, for the CSSOM reason in this file's header.
     */
    expect(POLICY).not.toContain("unsafe-inline")
    expect(POLICY).not.toContain("unsafe-eval")
    expect(directive("script-src")).toBe("script-src 'self'")
    expect(directive("style-src")).toBe("style-src 'self'")
  })

  it("permits exactly what the application was measured to need", () => {
    // `data:` for the inline SVG favicon in index.html, which exists so a
    // browser's unprompted /favicon.ico does not cost a 404 on every load.
    expect(directive("img-src")).toBe("img-src 'self' data:")
    // The service worker (F6). Without this the shell never installs and the
    // offline behaviour FR-8 promises silently stops existing.
    expect(directive("worker-src")).toBe("worker-src 'self'")
    expect(directive("manifest-src")).toBe("manifest-src 'self'")
  })

  it("can reach the API without listing a second origin", () => {
    /*
     * `'self'` is only sufficient because ADR-0009 serves `/api` through the
     * web origin. If that rewrite is ever removed, this line has to name the
     * API's host — and the refresh cookie stops being sent, which is the
     * failure P-14 was closed to prevent. Asserted so the two decisions stay
     * visibly connected.
     */
    expect(directive("connect-src")).toBe("connect-src 'self'")
  })

  it("closes the directives that have nothing to do with XSS", () => {
    // Clickjacking, base-tag injection, and plugin content. None of these are
    // covered by `default-src`, which is the usual reason they are missing.
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'")
    expect(directive("base-uri")).toBe("base-uri 'none'")
    expect(directive("object-src")).toBe("object-src 'none'")
    expect(directive("form-action")).toBe("form-action 'self'")
  })

  it("names no wildcard host", () => {
    // `*`, `https:` and `data:` in a fetch directive each turn a policy into
    // decoration. `data:` is allowed for images only, asserted above.
    for (const part of POLICY.split(";").map((p) => p.trim())) {
      if (part.startsWith("img-src")) continue
      expect(part, `wildcard in: ${part}`).not.toMatch(/\s\*|\shttps:|\sdata:/)
    }
  })
})

describe("the rest of the document origin's headers", () => {
  /*
   * Left out of the CSP change deliberately and recorded as a gap, on the
   * grounds that a diff should be about one thing. This is the follow-up:
   * the API has had these since B5 through helmet, and the origin that serves
   * the documents — and holds the access token — had none of them.
   */
  it("refuses MIME sniffing", () => {
    // A chunk served with the wrong content type is a chunk a browser may
    // decide to execute. `default-src 'none'` does not cover that.
    expect(DOCUMENT_HEADERS["X-Content-Type-Options"]).toBe("nosniff")
  })

  it("sends no referrer, matching the API", () => {
    /*
     * `no-referrer`, the same value helmet sets on the API. A wallet's paths
     * carry transfer ids (`/history/:id`), and a weaker policy leaks them to
     * whatever a user navigates to next.
     */
    expect(DOCUMENT_HEADERS["Referrer-Policy"]).toBe("no-referrer")
  })

  it("denies the device APIs this application never asks for", () => {
    const policy = DOCUMENT_HEADERS["Permissions-Policy"] ?? ""
    for (const feature of ["camera", "geolocation", "microphone", "payment", "usb"]) {
      expect(policy, feature).toContain(`${feature}=()`)
    }
  })
})
