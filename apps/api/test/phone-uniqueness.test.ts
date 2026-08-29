import { readdirSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { phoneBucketFor, uniquePhone } from "./helpers.js"

/**
 * The suite's own phone numbers, as an invariant rather than a hope.
 *
 * `uniquePhone` used to separate test files with `Math.random()` over three
 * digits. Twenty files in nine hundred buckets is about one collision every
 * five runs, and the collision does not surface where it was caused: the file
 * that draws the duplicate fails registration with a `400`, which reads as a
 * bug in registration. It cost a CI run on Node 22 while Node 24 passed on
 * identical code, which is the shape every flake takes — a coin landing
 * differently, wearing a version number.
 *
 * The derivation is deterministic now, so the question "do any two files
 * collide" has one answer per file set rather than one per run. This asks it.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

describe("the test suite cannot mint the same phone twice", () => {
  it("gives every test file its own bucket", () => {
    const files = readdirSync(TEST_DIR).filter((name) => name.endsWith(".test.ts"))

    // Guards the guard: a glob that silently matches nothing would pass every
    // assertion below.
    expect(files.length).toBeGreaterThan(10)

    const byBucket = new Map<string, string[]>()
    for (const file of files) {
      const bucket = phoneBucketFor(file)
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), file])
    }

    const clashes = [...byBucket.values()].filter((group) => group.length > 1)

    /*
     * If this fails, two test files hash onto one bucket and would hand each
     * other duplicate numbers. Rename either file — the bucket comes from the
     * basename — rather than widening the space, which only moves the next
     * collision somewhere less visible.
     */
    expect(clashes, `test files sharing a phone bucket: ${JSON.stringify(clashes)}`).toEqual([])
  })

  it("is stable across runs, which is the whole point", () => {
    expect(phoneBucketFor("history.test.ts")).toBe(phoneBucketFor("history.test.ts"))
    expect(phoneBucketFor("a/b/history.test.ts")).toBe(phoneBucketFor("c\\history.test.ts"))
  })

  it("produces a phone the contract accepts", () => {
    // Nine digits after +998 (`createRegionalPhoneSchema`), and the shape the
    // registration route parses. A bucket change that broke the length would
    // otherwise surface as a validation error somewhere unrelated.
    const phone = uniquePhone()

    expect(phone).toMatch(/^\+9989\d{8}$/)
    expect(phone).toHaveLength(13)
  })

  it("cannot collide with a seeded account", () => {
    /*
     * The seeded numbers are `88…` and the system account is `000000000`;
     * every minted one starts with `9`, so the two sets cannot meet. That is
     * currently a property of the format rather than a promise, which is the
     * kind of thing a later format change breaks silently — a minted number
     * landing on a demo account would fail registration in whichever file drew
     * it, exactly the failure this file exists to prevent.
     */
    const seeded = ["+998884615500", "+998884625500", "+998000000000"]
    const minted = Array.from({ length: 200 }, () => uniquePhone())

    expect(minted.filter((phone) => seeded.includes(phone))).toEqual([])
  })

  it("does not repeat within a file", () => {
    const minted = new Set(Array.from({ length: 500 }, () => uniquePhone()))

    expect(minted.size).toBe(500)
  })
})
