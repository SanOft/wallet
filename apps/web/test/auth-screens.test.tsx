import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/app/App.js"
import { resetRefreshState } from "../src/app/baseQuery.js"
import { resetSessionRestore } from "../src/features/auth/useSessionRestore.js"
import { clearSessionHint, giveSessionHint } from "./renderApp.js"

/**
 * §13.4's two screens, and the states that make them correct rather than
 * merely present.
 *
 * The one that matters most is the credentials failure. FR-2.2 makes the server
 * answer an unknown number and a wrong password identically, and spend an
 * argon2 hash on the unknown one so even the timings match. A screen that said
 * "no such number" would hand back everything that defence bought — so the test
 * below asserts the *absence* of a per-field message as firmly as the presence
 * of the generic one.
 */

interface Reply {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

let script: (url: string) => Reply | "network-failure"

function reply(r: Reply): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...r.headers },
  })
}

const SIGNED_OUT: Reply = { status: 401, body: {} }
const LONG_ENOUGH = ["orbit", "walnut", "lantern", "quiet"].join("-")

beforeEach(() => {
  resetRefreshState()
  resetSessionRestore()
  // Anonymous by default: no hint, so the app does not ask. The one test that
  // needs a session says so.
  clearSessionHint()
  window.history.pushState({}, "", "/login")

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url).pathname
    const answer = script(url)
    return answer === "network-failure"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(reply(answer))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function showLogin() {
  render(<App />)
  return screen.findByRole("heading", { name: "Kirish" })
}

async function fillCredentials(secret: string) {
  await userEvent.type(screen.getByLabelText(/telefon/i), "901234567")
  await userEvent.type(screen.getByLabelText(/parol/i), secret)
}

describe("signed out", () => {
  it("shows the login screen and no tab bar", async () => {
    script = () => SIGNED_OUT
    await showLogin()

    // Three tabs that all bounce back to this screen are three ways to be told
    // no.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument()
  })

  it("offers the way to an account", async () => {
    script = () => SIGNED_OUT
    await showLogin()

    expect(screen.getByRole("link", { name: /ro'yxatdan/i })).toHaveAttribute("href", "/register")
  })
})

describe("a rejected sign-in (FR-2.2)", () => {
  it("says one thing, about the form and not about a field", async () => {
    script = (url) =>
      url === "/api/auth/login"
        ? { status: 401, body: { error: { code: "AUTH_INVALID_CREDENTIALS", requestId: "r" } } }
        : SIGNED_OUT

    await showLogin()
    await fillCredentials(LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: "Kirish" }))

    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/raqam yoki parol/i)

    // The fields must carry nothing: "this number is not registered" is the
    // membership oracle the server pays an argon2 hash to avoid.
    expect(screen.getByLabelText(/telefon/i)).not.toHaveAccessibleDescription()
    expect(screen.getByLabelText(/parol/i)).not.toHaveAccessibleDescription()
  })

  it("does not blame the password when the request never left the device", async () => {
    script = (url) => (url === "/api/auth/login" ? "network-failure" : SIGNED_OUT)

    await showLogin()
    await fillCredentials(LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: "Kirish" }))

    // Telling someone their password is wrong when the network is down makes
    // them change a password that was fine, and leaves the real problem.
    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/aloqa/i)
    expect(notice).not.toHaveTextContent(/parol noto'g'ri/i)
  })
})

describe("the backoff, as the user meets it (FR-2.3, §12.3)", () => {
  it("names the wait from the header rather than guessing", async () => {
    script = (url) =>
      url === "/api/auth/login"
        ? {
            status: 429,
            body: { error: { code: "AUTH_LOCKED", message: "Too many attempts", requestId: "r" } },
            headers: { "retry-after": "125" },
          }
        : SIGNED_OUT

    await showLogin()
    await fillCredentials(LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: "Kirish" }))

    // 125 seconds, rendered the way §12.3 asks: a delay a person can act on,
    // not a number they have to divide.
    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/2 daqiqa 5 soniya/)
  })

  it("falls back to a usable sentence when the header is missing", async () => {
    script = (url) =>
      url === "/api/auth/login"
        ? { status: 429, body: { error: { code: "AUTH_LOCKED", requestId: "r" } } }
        : SIGNED_OUT

    await showLogin()
    await fillCredentials(LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: "Kirish" }))

    // Never "try again in 0 seconds", which invites the retry the backoff
    // exists to prevent.
    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/juda ko'p urinish/i)
    expect(notice).not.toHaveTextContent(/0 soniya/)
  })
})

describe("registration (§13.4)", () => {
  async function showRegister() {
    window.history.pushState({}, "", "/register")
    render(<App />)
    return screen.findByRole("heading", { name: /ro'yxatdan/i })
  }

  it("carries the warning that never comes down (FR-6.5)", async () => {
    script = () => SIGNED_OUT
    await showRegister()

    expect(
      screen.getByText(/hech qachon PIN yoki SMS kodni yuborishingizni so'ramaydi/i),
    ).toBeInTheDocument()
  })

  it("rates a password by length and by nothing else", async () => {
    script = () => SIGNED_OUT
    await showRegister()

    const password = screen.getByLabelText(/^parol$/i)
    // Nothing to rate yet, so nothing is said. A meter that announces "too
    // short" over an untouched field is scolding someone who has not typed.
    expect(screen.queryByRole("status")).not.toBeInTheDocument()

    await userEvent.type(password, "Aa1!Aa1!")

    // Scoped to the meter rather than the document: the field's own hint reads
    // "Uzunroq parol kuchliroq", so a loose /kuchli/ search matches the advice
    // and would pass no matter what the meter said.
    const meter = await screen.findByRole("status")

    // Eight characters with every character class the old rules asked for, and
    // still too short. Composition rules are why `Password1!` exists.
    expect(meter).toHaveTextContent(/juda qisqa/i)

    await userEvent.clear(password)
    await userEvent.type(password, "orbit walnut lantern quiet")

    // Re-queried rather than reused: clearing the field empties the meter,
    // which unmounts it, so the node captured above is detached and would keep
    // answering with the verdict it held when it died.
    const restated = await screen.findByRole("status")
    expect(restated).toHaveTextContent(/kuchli/i)

    // The band alone is a colour word to anyone who cannot see the bar, so the
    // meter also has to carry the count it is derived from.
    expect(restated).toHaveTextContent(/26 belgi/)
  })

  it("puts the server's field errors on the fields", async () => {
    script = (url) =>
      url === "/api/auth/register"
        ? {
            status: 400,
            body: {
              error: {
                code: "VALIDATION_ERROR",
                requestId: "r",
                details: [{ path: ["firstName"], code: "name.invalid" }],
              },
            },
          }
        : SIGNED_OUT

    await showRegister()
    await userEvent.type(screen.getByLabelText(/telefon/i), "901234567")
    await userEvent.type(screen.getByLabelText("Ism"), "Alisher")
    await userEvent.type(screen.getByLabelText(/familiya/i), "Navoiy")
    await userEvent.type(screen.getByLabelText(/^parol$/i), LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: /hisob ochish/i }))

    await waitFor(() => {
      expect(screen.getByLabelText("Ism")).toHaveAccessibleDescription(/harf/i)
    })
  })

  it("keeps a taken number generic (FR-1.5)", async () => {
    script = (url) =>
      url === "/api/auth/register"
        ? { status: 409, body: { error: { code: "REGISTRATION_FAILED", requestId: "r" } } }
        : SIGNED_OUT

    await showRegister()
    await userEvent.type(screen.getByLabelText(/telefon/i), "901234567")
    await userEvent.type(screen.getByLabelText("Ism"), "Alisher")
    await userEvent.type(screen.getByLabelText(/familiya/i), "Navoiy")
    await userEvent.type(screen.getByLabelText(/^parol$/i), LONG_ENOUGH)
    await userEvent.click(screen.getByRole("button", { name: /hisob ochish/i }))

    // "That number is already registered" is the same disclosure the login
    // screen refuses to make, arriving through a different door.
    const notice = await screen.findByRole("alert")
    expect(notice).toHaveTextContent(/tekshirib/i)
    expect(screen.getByLabelText(/telefon/i)).not.toHaveAccessibleDescription()
  })
})

describe("someone already signed in", () => {
  it("is sent past the login screen rather than shown it again", async () => {
    giveSessionHint()
    script = (url) =>
      url === "/api/auth/refresh"
        ? { status: 200, body: { accessToken: "session", user: null } }
        : { status: 200, body: {} }

    render(<App />)

    // The tab bar is the shell; reaching it means the redirect happened.
    await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument())
    expect(screen.queryByRole("heading", { name: "Kirish" })).not.toBeInTheDocument()
  })
})
