import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { AmountInput, displayAmount, majorDigits, toMinor } from "../src/components/AmountInput.js"
import { FormField } from "../src/components/FormField.js"
import { Input } from "../src/components/Input.js"
import { displayPhone, nationalDigits, PhoneInput } from "../src/components/PhoneInput.js"
import { PinInput } from "../src/components/PinInput.js"

/**
 * §13.8.1, row by row.
 *
 * The table is the specification of these fields, so it is the test data. Every
 * attribute it names is asserted on the element that ships, because each one is
 * invisible until the day it is missing — and by then the symptom is a keyboard
 * that will not appear or an autofill that puts a password into a phone box.
 */

const noop = () => undefined

function renderField(node: React.ReactNode) {
  return render(<FormField label="Maydon">{() => node}</FormField>)
}

describe("§13.8.1 — the attribute table", () => {
  it("phone: tel, autocomplete tel, one field and not three", () => {
    renderField(
      <PhoneInput
        id="p"
        value="+998901234567"
        describedBy={undefined}
        invalid={false}
        onChange={noop}
        onBlur={noop}
      />,
    )

    const input = screen.getByRole("textbox")
    expect(input).toHaveAttribute("type", "tel")
    expect(input).toHaveAttribute("autocomplete", "tel")
    expect(screen.getAllByRole("textbox")).toHaveLength(1)
  })

  it("amount: text with inputmode numeric, never type=number", () => {
    renderField(
      <AmountInput
        id="a"
        value=""
        describedBy={undefined}
        invalid={false}
        onChange={noop}
        onBlur={noop}
      />,
    )

    const input = screen.getByRole("textbox")
    // The reason is in the component: spinners on money, a scroll wheel that
    // silently edits the amount, and `1e5` accepted as a number.
    expect(input).toHaveAttribute("type", "text")
    expect(input).toHaveAttribute("inputmode", "numeric")
    expect(input).toHaveAttribute("autocomplete", "transaction-amount")
  })

  it("pin: password, numeric keypad, and never remembered", () => {
    const { container } = render(
      <PinInput
        id="pin"
        value=""
        label="PIN"
        describedBy={undefined}
        invalid={false}
        onChange={noop}
        onBlur={noop}
      />,
    )

    const input = container.querySelector("input")
    expect(input).toHaveAttribute("type", "password")
    expect(input).toHaveAttribute("inputmode", "numeric")
    expect(input).toHaveAttribute("autocomplete", "off")
    expect(input).toHaveAttribute("maxlength", "4")
  })

  it("passwords: the two of them ask autofill for different things", () => {
    const { container } = render(
      <>
        <Input type="password" autoComplete="current-password" aria-label="Parol" />
        <Input type="password" autoComplete="new-password" aria-label="Yangi parol" />
      </>,
    )

    const [login, created] = [...container.querySelectorAll("input")]
    // `new-password` is what makes a browser offer to generate one; using
    // `current-password` there means it never does.
    expect(login).toHaveAttribute("autocomplete", "current-password")
    expect(created).toHaveAttribute("autocomplete", "new-password")
  })

  it("names: given-name and family-name, so autofill fills the right box", () => {
    const { container } = render(
      <>
        <Input type="text" autoComplete="given-name" aria-label="Ism" />
        <Input type="text" autoComplete="family-name" aria-label="Familiya" />
      </>,
    )

    const [first, last] = [...container.querySelectorAll("input")]
    expect(first).toHaveAttribute("autocomplete", "given-name")
    expect(last).toHaveAttribute("autocomplete", "family-name")
  })

  it("every field asks for at least 16px, which is what stops iOS zooming", () => {
    // §13.2.3's hard rule. The token's own minimum is checked in
    // `contrast.test.ts`'s neighbour; here we prove the field spends it rather
    // than setting a size of its own.
    const { container } = render(<Input aria-label="x" />)
    expect(container.querySelector("input")?.getAttribute("style")).toContain("var(--text-step-0)")
  })

  it("enterkeyhint matches the step, so the keyboard says what happens next", () => {
    const { container } = render(
      <PinInput
        id="pin"
        value=""
        describedBy={undefined}
        invalid={false}
        onChange={noop}
        onBlur={noop}
      />,
    )
    // A PIN is the last thing entered before something happens.
    expect(container.querySelector("input")).toHaveAttribute("enterkeyhint", "done")
  })
})

describe("the phone mask is display only", () => {
  it("shows groups but stores E.164", async () => {
    // Controlled, so the harness has to hold the value: without it every
    // keystroke is applied to the same stale string and the test measures its
    // own wiring rather than the component.
    const seen: string[] = []
    function Controlled() {
      const [value, setValue] = useState("+998")
      return (
        <PhoneInput
          id="p"
          value={value}
          describedBy={undefined}
          invalid={false}
          onChange={(next) => {
            seen.push(next)
            setValue(next)
          }}
          onBlur={noop}
        />
      )
    }

    render(<Controlled />)
    const input = screen.getByRole("textbox")
    await userEvent.type(input, "901234567")

    expect(seen.at(-1)).toBe("+998901234567")
    // And what the user reads is the mask, not the stored form.
    expect(input).toHaveValue("+998 90 123 45 67")
  })

  it("renders a half-typed number without inventing the rest", () => {
    expect(displayPhone("901")).toBe("+998 90 1")
    expect(displayPhone("")).toBe("+998")
  })

  it("survives a paste full of separators (D-7)", () => {
    // The digits were never in doubt; refusing the paste would be the bug.
    expect(nationalDigits("+998 (90) 123-45-67")).toBe("901234567")
    expect(nationalDigits("90 123 45 67")).toBe("901234567")
  })

  it("refuses to hold more than the region allows", () => {
    expect(nationalDigits("9012345671111")).toBe("901234567")
  })
})

describe("the amount field speaks so'm and stores tiyin", () => {
  it("groups digits as they arrive", () => {
    expect(displayAmount("1250000")).toBe("1 250 000")
    expect(displayAmount("100")).toBe("100")
  })

  it("scales to minor units, which is what the schema parses", () => {
    expect(toMinor("1250000")).toBe("125000000")
    expect(toMinor("")).toBe("")
  })

  it("drops leading zeros rather than showing 007", () => {
    expect(majorDigits("007")).toBe("7")
    expect(majorDigits("0")).toBe("")
  })

  it("ignores everything that is not a digit", () => {
    expect(majorDigits("1e5")).toBe("15")
    expect(majorDigits("-100")).toBe("100")
  })

  it("round-trips a value the form already holds", () => {
    const onChange = vi.fn()
    render(
      <AmountInput
        id="a"
        value="125000000"
        describedBy={undefined}
        invalid={false}
        onChange={onChange}
        onBlur={noop}
      />,
    )
    expect(screen.getByRole("textbox")).toHaveValue("1 250 000")
  })
})

describe("FormField wires the parts together (§13.8.2)", () => {
  it("labels the control through for/id, not a placeholder", () => {
    render(<FormField label="Telefon">{({ id }) => <input id={id} />}</FormField>)
    expect(screen.getByLabelText("Telefon")).toBeInTheDocument()
  })

  it("announces the error as part of the field", () => {
    render(
      <FormField label="Telefon" error="Raqam 9 ta raqamdan iborat bo'lishi kerak">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>,
    )

    const input = screen.getByLabelText("Telefon")
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription(/9 ta raqam/)
  })

  it("marks the error with more than colour", () => {
    const { container } = render(
      <FormField label="Summa" error="Eng kam summa — 1 000 so'm">
        {({ id }) => <input id={id} />}
      </FormField>,
    )

    // NFR-4: an icon *and* text, so the message survives a colour-blind reader
    // and a monochrome screenshot alike. The icon is hidden from assistive
    // technology because the sentence beside it already says the same thing —
    // `icons.test.tsx` holds that rule across everything.
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(screen.getByRole("status").textContent).toContain("Eng kam summa")
  })

  it("keeps a hint and an error as separate descriptions", () => {
    render(
      <FormField label="Parol" hint="Kamida 15 belgi" error="Juda qisqa">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}
      </FormField>,
    )
    expect(screen.getByLabelText("Parol")).toHaveAccessibleDescription(
      /Kamida 15 belgi.*Juda qisqa/,
    )
  })
})
