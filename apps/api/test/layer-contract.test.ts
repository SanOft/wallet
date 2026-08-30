/**
 * @vitest-environment node
 *
 * Reads the domain sources from disk. Nothing here touches a DOM.
 */
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * §8.3's layer contract, as a rule rather than as a diagram.
 *
 * The spec states it plainly: "domain services know nothing about `req`/`res`,
 * HTTP status codes, or `CON`/`END`. They receive plain input objects and
 * return either a result or a typed domain error. This is why the USSD channel
 * plugs in without changing **a single line** of the domain."
 *
 * That last sentence is the whole return on the layering, and it is a claim
 * about the future: it holds only while the contract does. §8.2's equivalent
 * was "held by review rather than by a rule" until P-10 made it a test — and
 * P-10 records why review is not enough, which is that a restriction matching
 * nothing looks exactly like one that works.
 *
 * This file exists because the contract is unbroken *today*, so writing it down
 * costs nothing and locks in a property that is currently free. The expensive
 * moment is the one after a protocol detail has already leaked in: a third
 * channel is then not plugged in, it is written.
 *
 * Note what is deliberately *not* forbidden. The domain imports from `infra`,
 * and §8.3's own diagram draws that edge — `AUTH & TRANSFER & ACCOUNT -->
 * PRISMA`. Depending on the database is the design; depending on a transport
 * is not.
 */

const DOMAIN = new URL("../src/domain/", import.meta.url)

interface Source {
  readonly name: string
  readonly text: string
}

function domainSources(): readonly Source[] {
  return readdirSync(DOMAIN)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, DOMAIN), "utf8") }))
}

const SOURCES = domainSources()

/**
 * Comments are not dependencies. Strings are.
 *
 * A doc comment explaining what a route does with this value is the layering
 * being *documented* rather than crossed, so comments go — otherwise the file
 * would be noisy enough to get silenced, which is the failure a guard cannot
 * survive.
 *
 * String literals are deliberately kept, and the first version of this file
 * stripped them. That was wrong in a way its own last test caught: an import
 * specifier *is* a string, so `from "express"` became `from ""` and the import
 * rules could never fire. `CON`/`END` would have gone the same way, since a
 * USSD reply reaches the code as a literal. Stripping strings blinds three of
 * the four rules while leaving all of them visible in the source.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

describe("§8.3 — the domain knows nothing about a transport", () => {
  it("read the domain layer", () => {
    /*
     * The control. Every assertion below iterates a list, and an empty list
     * satisfies all of them — a renamed directory would turn this file green
     * rather than red, which is exactly the shape P-10 warns about.
     */
    expect(SOURCES.length, "no domain sources were read").toBeGreaterThanOrEqual(5)
    expect(SOURCES.map((s) => s.name)).toContain("TransferService.ts")
  })

  it.each([
    { what: "an adapter", pattern: /from\s+["']\.\.\/adapters\// },
    { what: "express", pattern: /from\s+["']express["']/ },
    {
      what: "an HTTP request or response",
      pattern: /\breq\.(body|headers|ip|get)\b|\bres\.(status|json|send)\b/,
    },
    { what: "a USSD reply prefix", pattern: /\b(CON|END)\s+[A-Za-z]/ },
  ])("imports or mentions no $what", ({ what, pattern }) => {
    const offenders = SOURCES.filter((source) => pattern.test(code(source.text))).map((s) => s.name)

    /*
     * If this fails, a transport detail has reached the layer whose whole
     * purpose is not to have one. The fix is not to widen this test: it is to
     * move the detail back into the adapter that owns it, because the moment
     * the domain speaks a protocol, the next channel stops being a plug-in.
     */
    expect(offenders, `the domain now mentions ${what}`).toEqual([])
  })

  it("catches a violation rather than merely describing one", () => {
    /*
     * The guard's own guard, and it has already earned its place: the first
     * version of `code()` stripped string literals along with comments, which
     * silently disabled the import and USSD rules — and this is the assertion
     * that said so. Every rule is exercised against code that must trip it.
     */
    const violating = code(
      [
        'import { Router } from "express"',
        'import { respond } from "../adapters/http/respond.js"',
        "res.status(422).json({ ok: req.body })",
        'return "END Xizmat band."',
      ].join("\n"),
    )

    expect(/from\s+["']express["']/.test(violating), "the express rule is dead").toBe(true)
    expect(/from\s+["']\.\.\/adapters\//.test(violating), "the adapter rule is dead").toBe(true)
    expect(/\bres\.(status|json|send)\b/.test(violating), "the response rule is dead").toBe(true)
    expect(/\breq\.(body|headers|ip|get)\b/.test(violating), "the request rule is dead").toBe(true)
    expect(/\b(CON|END)\s+[A-Za-z]/.test(violating), "the USSD rule is dead").toBe(true)

    // And prose about a transport must still not trip anything.
    expect(code("// the adapter turns this into res.status(422)").trim()).toBe("")
  })
})
