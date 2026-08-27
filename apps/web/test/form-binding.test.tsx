import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { registerRequestSchema } from "@wallet/shared"
import { describe, expect, it, vi } from "vitest"
import { FormField } from "../src/components/FormField.js"
import { Input } from "../src/components/Input.js"
import { useForm } from "../src/lib/useForm.js"

/**
 * §13.8.2's policy table, as behaviour.
 *
 * Each of these is a row someone could implement the opposite way and still
 * ship a form that "works": validating on every keystroke, disabling submit
 * until the form is valid, showing one error at a time. They are all worse for
 * the person filling it in, and none of them fails a smoke test.
 */

function Harness(props: { onSubmit?: (value: unknown) => void }) {
  const form = useForm({
    schema: registerRequestSchema,
    initial: { phone: "", firstName: "", lastName: "", password: "" },
    onSubmit: props.onSubmit ?? (() => undefined),
  })

  return (
    <form onSubmit={form.handleSubmit} noValidate>
      {(["phone", "firstName", "lastName", "password"] as const).map((name) => {
        const field = form.field(name)
        return (
          <FormField key={name} label={name} error={field.error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={field.value}
                aria-describedby={describedBy}
                invalid={invalid}
                onChange={(event) => field.onChange(event.target.value)}
                onBlur={field.onBlur}
              />
            )}
          </FormField>
        )
      })}
      <button type="submit" disabled={form.submitting}>
        Yuborish
      </button>
    </form>
  )
}

describe("validation timing", () => {
  it("says nothing while a field is still being typed", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByLabelText("phone"), "+998")

    // A complaint that appears mid-word is a complaint about an unfinished
    // value, and the user has not stopped working on it yet.
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("speaks when the field is left", async () => {
    render(<Harness />)
    const phone = screen.getByLabelText("phone")

    await userEvent.type(phone, "+99890")
    await userEvent.tab()

    expect(await screen.findByRole("status")).toHaveTextContent(/9 ta raqam|ko'rinishida/)
  })

  it("complains about the field left, and not about the ones untouched", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByLabelText("phone"), "+99890")
    await userEvent.tab()

    // Three other fields are empty and invalid. Lighting them up here would be
    // telling the user off for work they have not reached.
    expect(screen.getAllByRole("status")).toHaveLength(1)
  })

  it("clears a complaint as soon as the user starts fixing it", async () => {
    render(<Harness />)
    const phone = screen.getByLabelText("phone")

    await userEvent.type(phone, "+99890")
    await userEvent.tab()
    expect(phone).toHaveAccessibleDescription(/ko'rinishida|9 ta raqam/)

    await userEvent.type(phone, "1")

    // Asserted on this field rather than on the page: tabbing away visited the
    // next field, so leaving it raised *its* error, and a page-wide query would
    // find that one and call this a failure.
    expect(phone).not.toHaveAccessibleDescription()
    expect(phone).not.toHaveAttribute("aria-invalid")
  })
})

describe("submit", () => {
  it("is never disabled before it is pressed", () => {
    render(<Harness />)
    // web.dev: a dead button leaves the user guessing which field is at fault.
    // The form is empty and entirely invalid, and the button still works.
    expect(screen.getByRole("button")).toBeEnabled()
  })

  it("shows every fault at once, so the form is fixed in one pass", async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole("button"))

    expect(await screen.findAllByRole("status")).toHaveLength(4)
  })

  it("does not call the handler while anything is invalid", async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole("button"))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("hands over parsed data, not the strings that were typed", async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText("phone"), "+998901234567")
    await userEvent.type(screen.getByLabelText("firstName"), "Alisher")
    await userEvent.type(screen.getByLabelText("lastName"), "Navoiy")
    await userEvent.type(screen.getByLabelText("password"), "orbit-walnut-lantern-quiet")
    await userEvent.click(screen.getByRole("button"))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+998901234567", firstName: "Alisher" }),
    )
  })

  it("goes dead once pressed, which is half of S-6", async () => {
    // The other half is the idempotency key. Two layers, because this one is
    // only as reliable as the browser's event loop.
    let release: () => void = () => undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    render(<Harness onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText("phone"), "+998901234567")
    await userEvent.type(screen.getByLabelText("firstName"), "Alisher")
    await userEvent.type(screen.getByLabelText("lastName"), "Navoiy")
    await userEvent.type(screen.getByLabelText("password"), "orbit-walnut-lantern-quiet")

    const button = screen.getByRole("button")
    await userEvent.click(button)
    expect(button).toBeDisabled()

    await userEvent.click(button)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    release()
  })
})
