import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"
import { ErrorBoundary } from "../src/components/ErrorBoundary.js"
import { reportError, reportUnexpected } from "../src/lib/report.js"

/**
 * The boundary, and the rule it enforces: nothing fails without saying so.
 *
 * Before this existed, a render that threw unmounted the whole tree — a blank
 * page, no navigation, no explanation. On a wallet that is indistinguishable
 * from a stolen account, and it is the worst thing this application could do
 * to someone.
 */

function Explodes(): never {
  throw new Error("boom")
}

// Typed rather than inferred: `vi.spyOn`'s return type does not carry the
// argument tuple, so `mock.calls` lands as `any[]` and the filter below stops
// being checked at all.
let consoleError: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
  // React prints the caught error itself; silenced so a passing run is not
  // full of stack traces that look like failures.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a component that throws", () => {
  it("is contained, and says what is missing rather than nothing", async () => {
    render(
      <ErrorBoundary scope="rates" title="Kurslarni ko'rsatib bo'lmadi.">
        <Explodes />
      </ErrorBoundary>,
    )

    const notice = await screen.findByRole("alert")
    // Not "something went wrong": a user told the rates failed knows their
    // balance is still trustworthy.
    expect(notice).toHaveTextContent(/kurslarni ko'rsatib bo'lmadi/i)
  })

  it("does not take its siblings with it", async () => {
    render(
      <>
        <p>1 250 000 so&apos;m</p>
        <ErrorBoundary scope="rates">
          <Explodes />
        </ErrorBoundary>
      </>,
    )

    await screen.findByRole("alert")
    // The whole reason boundaries are placed per section rather than only at
    // the root.
    expect(screen.getByText("1 250 000 so'm")).toBeInTheDocument()
  })

  it("reports the failure, naming the part that failed", async () => {
    render(
      <ErrorBoundary scope="balance">
        <Explodes />
      </ErrorBoundary>,
    )
    await screen.findByRole("alert")

    // React logs in development and says nothing in production, so without a
    // report of our own a released build fails silently by design.
    const reported = consoleError.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("render:balance"),
    )
    expect(reported).toHaveLength(1)
  })

  it("can be retried without reloading the page", async () => {
    let broken = true
    function Sometimes() {
      if (broken) throw new Error("boom")
      return <p>Balans</p>
    }

    render(
      <ErrorBoundary scope="balance">
        <Sometimes />
      </ErrorBoundary>,
    )
    await screen.findByRole("alert")

    broken = false
    await userEvent.click(screen.getByRole("button", { name: /qayta urinish/i }))

    // A boundary with no way out turns a transient fault into a dead section
    // until the user thinks to reload — which most people do not.
    await waitFor(() => expect(screen.getByText("Balans")).toBeInTheDocument())
  })
})

describe("what gets reported", () => {
  it("never lets reporting itself break the page", () => {
    consoleError.mockImplementation(() => {
      throw new Error("console is gone")
    })

    // A console that throws is absurd — and absurd is exactly what turns a
    // handled failure into a white screen.
    expect(() => reportError("scope", new Error("x"))).not.toThrow()
  })

  it("stays quiet about outcomes the interface already explains", () => {
    const wrongPassword = { data: { error: { code: "AUTH_INVALID_CREDENTIALS" } } }

    reportUnexpected("auth:login", wrongPassword, ["AUTH_INVALID_CREDENTIALS"])

    // A console where every wrong password scrolls past is a console nobody
    // reads, which is the same as no reporting at all.
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("speaks up about anything else", () => {
    const somethingElse = { data: { error: { code: "INTERNAL" } } }

    reportUnexpected("auth:login", somethingElse, ["AUTH_INVALID_CREDENTIALS"])

    expect(consoleError).toHaveBeenCalled()
  })

  it("speaks up when the failure has no code at all", () => {
    // A network failure, or an error shape nobody planned for. Treating an
    // unrecognised thing as handled is how a new failure mode arrives silently.
    reportUnexpected("auth:login", new TypeError("Failed to fetch"), ["AUTH_INVALID_CREDENTIALS"])

    expect(consoleError).toHaveBeenCalled()
  })
})
