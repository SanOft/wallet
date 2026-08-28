import { registerRequestSchema } from "@wallet/shared"
import { ShieldAlert, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { FormField } from "../../components/FormField.js"
import { Input } from "../../components/Input.js"
import { PhoneInput } from "../../components/PhoneInput.js"
import { fromApi } from "../../lib/fieldErrors.js"
import { useForm } from "../../lib/useForm.js"
import { useRegisterMutation } from "./api.js"
import { PasswordStrength } from "./PasswordStrength.js"

/**
 * §13.4's registration screen.
 *
 * Field errors are shown here, unlike on the login form, and the difference is
 * FR-1.5 rather than inconsistency: telling someone their name is too long
 * reveals nothing, while telling them a number is already registered reveals
 * that it is. So per-field messages are rendered for the fields the user can
 * fix, and the one failure that would leak membership — a number already taken
 * — comes back as the same generic sentence a success-shaped failure would.
 */

const TAKEN_OR_UNKNOWN =
  "Ro'yxatdan o'tkazib bo'lmadi. Ma'lumotlarni tekshirib, qayta urinib ko'ring."

export function RegisterScreen() {
  const navigate = useNavigate()
  const [register, request] = useRegisterMutation()
  const [notice, setNotice] = useState<string | null>(null)

  const form = useForm({
    schema: registerRequestSchema,
    initial: { phone: "+998", firstName: "", lastName: "", password: "" },
    onSubmit: async (value) => {
      setNotice(null)
      const result = await register(value)

      if ("error" in result) {
        const error = result.error as { data?: unknown }
        const details = (error.data as { error?: { details?: unknown } } | undefined)?.error
          ?.details

        /*
         * The server's own field codes, rendered through the same dictionary
         * the client validates with. Anything it cannot place on a field — a
         * number already registered, above all — becomes one generic sentence
         * (FR-1.5).
         */
        const fields = fromApi(
          Array.isArray(details) ? (details as Parameters<typeof fromApi>[0]) : undefined,
        )
        if (Object.keys(fields).length > 0) form.setErrors(fields)
        else setNotice(TAKEN_OR_UNKNOWN)
        return
      }

      navigate("/", { replace: true })
    },
  })

  const phone = form.field("phone")
  const firstName = form.field("firstName")
  const lastName = form.field("lastName")
  const password = form.field("password")

  return (
    <div className="mx-auto flex max-w-[26rem] flex-col gap-l">
      <header className="flex flex-col gap-3xs">
        <h1 className="m-0 text-step-3">Ro&apos;yxatdan o&apos;tish</h1>
        <p className="m-0 text-(--color-text-secondary)">
          Hisob ochish uchun to&apos;rtta maydon yetarli.
        </p>
      </header>

      {notice ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs rounded-(--radius-card) p-s text-step--1"
          style={{ background: "var(--color-surface-sunken)", color: "var(--color-danger)" }}
        >
          <TriangleAlert size={18} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{notice}</span>
        </p>
      ) : null}

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

        <div className="flex flex-col gap-3xs">
          <FormField label="Parol" hint="Uzunroq parol kuchliroq" error={password.error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                // `new-password` is what makes a browser offer to generate one.
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
          <PasswordStrength value={password.value} />
        </div>

        <button
          type="submit"
          disabled={request.isLoading}
          className="rounded-(--radius-control) bg-(--color-primary) px-s text-(--color-on-primary)"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          {request.isLoading ? "Yaratilmoqda…" : "Hisob ochish"}
        </button>
      </form>

      {/* FR-6.5: permanent, on the screen where an account begins. */}
      <p className="m-0 flex items-start gap-2xs text-step--1 text-(--color-text-secondary)">
        <ShieldAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
        <span>
          Wallet xodimlari hech qachon PIN yoki SMS kodni yuborishingizni so&apos;ramaydi.
        </span>
      </p>

      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        Hisobingiz bormi?{" "}
        <Link to="/login" className="text-(--color-primary) underline">
          Kirish
        </Link>
      </p>
    </div>
  )
}
