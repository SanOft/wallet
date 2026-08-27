import { createTransferAmountSchema, registerRequestSchema } from "@wallet/shared"
import { useState } from "react"
import { AmountInput } from "../components/AmountInput.js"
import { FormField } from "../components/FormField.js"
import { Input } from "../components/Input.js"
import { PhoneInput } from "../components/PhoneInput.js"
import { PinInput } from "../components/PinInput.js"
import { messageFor } from "../lib/fieldErrors.js"
import { useForm } from "../lib/useForm.js"

/**
 * The F0.5 primitives, wired to the schemas that will validate them in F2.
 *
 * Nothing here is a screen — the real registration form arrives with the auth
 * feature. This exists so the primitives can be seen behaving: the mask filling
 * as digits arrive, the amount grouping itself, an error appearing on blur and
 * leaving on the next keystroke. A component library nobody has looked at is a
 * component library nobody has checked.
 */

const amountSchema = createTransferAmountSchema("UZS")

export function FormShowcase() {
  const [submitted, setSubmitted] = useState<string | null>(null)

  const form = useForm({
    schema: registerRequestSchema,
    initial: { phone: "+998", firstName: "", lastName: "", password: "" },
    onSubmit: (value) => {
      setSubmitted(JSON.stringify(value, null, 2))
    },
  })

  const [amount, setAmount] = useState("")
  const [amountError, setAmountError] = useState<string | undefined>(undefined)
  const [pin, setPin] = useState("")

  const phone = form.field("phone")
  const firstName = form.field("firstName")
  const lastName = form.field("lastName")
  const password = form.field("password")

  return (
    <section aria-labelledby="forms-heading" className="flex flex-col gap-2xs">
      <h2 id="forms-heading" className="m-0 text-step-1">
        Forma primitivlari
      </h2>
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        Sxemalar `packages/shared` dan — server ham xuddi shularni tekshiradi.
      </p>

      <form onSubmit={form.handleSubmit} noValidate className="flex flex-col gap-s">
        <FormField label="Telefon raqami" error={phone.error}>
          {({ id, describedBy, invalid }) => (
            <PhoneInput
              id={id}
              value={phone.value}
              describedBy={describedBy}
              invalid={invalid}
              onChange={phone.onChange}
              onBlur={phone.onBlur}
            />
          )}
        </FormField>

        <FormField label="Ism" error={firstName.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="text"
              autoComplete="given-name"
              enterKeyHint="next"
              value={firstName.value}
              aria-describedby={describedBy}
              invalid={invalid}
              onChange={(event) => firstName.onChange(event.target.value)}
              onBlur={firstName.onBlur}
            />
          )}
        </FormField>

        <FormField label="Familiya" error={lastName.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="text"
              autoComplete="family-name"
              enterKeyHint="next"
              value={lastName.value}
              aria-describedby={describedBy}
              invalid={invalid}
              onChange={(event) => lastName.onChange(event.target.value)}
              onBlur={lastName.onBlur}
            />
          )}
        </FormField>

        <FormField label="Parol" hint="Kamida 15 belgi" error={password.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              enterKeyHint="done"
              value={password.value}
              aria-describedby={describedBy}
              invalid={invalid}
              onChange={(event) => password.onChange(event.target.value)}
              onBlur={password.onBlur}
            />
          )}
        </FormField>

        <button
          type="submit"
          disabled={form.submitting}
          className="rounded-(--radius-control) bg-(--color-primary) px-s text-(--color-on-primary)"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          Tekshirish
        </button>
      </form>

      {submitted ? (
        <pre
          role="status"
          className="m-0 overflow-x-auto rounded-(--radius-card) bg-(--color-surface-sunken) p-s text-step--1"
        >
          {submitted}
        </pre>
      ) : null}

      <FormField label="Summa" hint="1 000 dan 10 000 000 so'mgacha" error={amountError}>
        {({ id, describedBy, invalid }) => (
          <AmountInput
            id={id}
            value={amount}
            describedBy={describedBy}
            invalid={invalid}
            onChange={(minor) => {
              setAmount(minor)
              setAmountError(undefined)
            }}
            onBlur={() => {
              const result = amountSchema.safeParse(amount)
              // The amount schema validates a value rather than an object, so
              // its issue carries no path and `fromZod` — which keys by field —
              // has nothing to key on. The code is read straight off the issue.
              setAmountError(
                result.success ? undefined : messageFor(result.error.issues[0]?.message ?? ""),
              )
            }}
          />
        )}
      </FormField>

      <FormField label="PIN" hint="4 raqam">
        {({ id, describedBy, invalid }) => (
          <PinInput
            id={id}
            value={pin}
            describedBy={describedBy}
            invalid={invalid}
            onChange={setPin}
            onBlur={() => undefined}
          />
        )}
      </FormField>
    </section>
  )
}
