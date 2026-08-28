import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { UpdatePrompt } from "../src/app/UpdatePrompt.js"
import { __appliedUpdates, __resetRegisterSW, __setUpdatePending } from "./stubs/pwa-register.js"

/**
 * The update bar, which exists so that a new build never installs itself
 * underneath somebody.
 *
 * `autoUpdate` reloads the page the moment a newer build is precached. On a
 * wallet that can land while a person is halfway through typing an amount, and
 * what they typed is gone with no explanation — a silent failure of exactly
 * the kind the rest of this application has been removing.
 */

afterEach(() => {
  __resetRegisterSW()
})

describe("a newer build", () => {
  it("is not mentioned when there is not one", () => {
    render(<UpdatePrompt />)

    expect(screen.queryByText(/yangi versiya/i)).not.toBeInTheDocument()
  })

  it("is offered rather than applied", async () => {
    __setUpdatePending(true)
    render(<UpdatePrompt />)

    expect(await screen.findByText(/yangi versiya tayyor/i)).toBeInTheDocument()
    // Nothing happens until the user says so. The whole point.
    expect(__appliedUpdates()).toBe(0)

    await userEvent.click(screen.getByRole("button", { name: /yangilash/i }))
    expect(__appliedUpdates()).toBe(1)
  })

  it("is announced without interrupting", async () => {
    __setUpdatePending(true)
    render(<UpdatePrompt />)

    const bar = await screen.findByText(/yangi versiya tayyor/i)
    // `status`, not `alert`: a newer build is worth mentioning at the next
    // pause and is never worth cutting across what someone is doing.
    expect(bar.closest("[role='status']")).not.toBeNull()
    expect(bar.closest("[role='alert']")).toBeNull()
  })

  it("gives the action a real touch target (NFR-3)", async () => {
    __setUpdatePending(true)
    render(<UpdatePrompt />)

    const button = await screen.findByRole("button", { name: /yangilash/i })
    // Sits above the tab bar at the bottom of a phone, which is the hardest
    // place on the screen to hit accurately.
    expect(button.style.minHeight).toBe("var(--touch-target-min)")
  })
})
