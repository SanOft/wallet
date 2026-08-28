import { loginRequestSchema } from "@wallet/shared"
import { TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { FormField } from "../../components/FormField.js"
import { Input } from "../../components/Input.js"
import { PhoneInput } from "../../components/PhoneInput.js"
import { useForm } from "../../lib/useForm.js"
import { useLoginMutation } from "./api.js"
import { type AuthFailure, formatWait, interpret } from "./authError.js"

/**
 * §13.4's login screen.
 *
 * The shape of this form is decided by FR-2.2 rather than by taste: the server
 * answers an unknown number and a wrong password identically, and spends an
 * argon2 hash on the unknown one so the timings match. A screen that then said
 * "no such number" would hand back everything that defence bought. So the
 * credentials failure is one sentence attached to the form, never to a field.
 */

/** Counts down a lockout so the message stays true while it is on screen. */
function useCountdown(from: number | undefined): number | undefined {
  const [remaining, setRemaining] = useState(from)

  useEffect(() => {
    setRemaining(from)
    if (from === undefined) return

    const timer = setInterval(() => {
      setRemaining((current) => (current === undefined || current <= 1 ? 0 : current - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [from])

  return remaining
}

function FailureNotice(props: { readonly failure: AuthFailure }) {
  const remaining = useCountdown(
    props.failure.kind === "locked" ? props.failure.retryAfterSeconds : undefined,
  )

  const text =
    props.failure.kind === "locked"
      ? remaining && remaining > 0
        ? `Juda ko'p urinish. ${formatWait(remaining)}dan so'ng qayta urinib ko'ring.`
        : "Juda ko'p urinish. Endi qayta urinib ko'rishingiz mumkin."
      : props.failure.message

  return (
    <p
      /*
       * `alert`, not `status`: this appears after the user pressed a button and
       * is the answer to it, so interrupting is correct. The strength meter
       * next door uses `status` for the opposite reason.
       */
      role="alert"
      className="m-0 flex items-start gap-2xs rounded-(--radius-card) p-s text-step--1"
      style={{ background: "var(--color-surface-sunken)", color: "var(--color-danger)" }}
    >
      <TriangleAlert size={18} aria-hidden={true} className="mt-3xs shrink-0" />
      <span>{text}</span>
    </p>
  )
}

export function LoginScreen() {
  const navigate = useNavigate()
  const [login, request] = useLoginMutation()
  const [failure, setFailure] = useState<AuthFailure | null>(null)

  const form = useForm({
    schema: loginRequestSchema,
    initial: { phone: "+998", password: "" },
    onSubmit: async (value) => {
      setFailure(null)
      const result = await login(value)
      if ("error" in result) {
        setFailure(interpret(result.error))
        return
      }
      navigate("/", { replace: true })
    },
  })

  const phone = form.field("phone")
  const password = form.field("password")

  return (
    <div className="mx-auto flex max-w-[26rem] flex-col gap-l">
      <header className="flex flex-col gap-3xs">
        <h1 className="m-0 text-step-3">Kirish</h1>
        <p className="m-0 text-(--color-text-secondary)">Raqamingiz va parolingizni kiriting.</p>
      </header>

      {failure ? <FailureNotice failure={failure} /> : null}

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

        <FormField label="Parol" error={password.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              // Not `new-password`: this is where a manager should offer the
              // one it already holds, and offering to generate a fresh one on
              // a sign-in form is how people end up locked out.
              autoComplete="current-password"
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
          /*
           * Disabled only while the request is in flight — never because the
           * form looks incomplete. A button that is dead before it is pressed
           * leaves the user guessing which field is at fault (§13.8.2), and
           * this one is also the double-tap defence S-6 pairs with the
           * idempotency key.
           */
          disabled={request.isLoading}
          className="rounded-(--radius-control) bg-(--color-primary) px-s text-(--color-on-primary)"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          {request.isLoading ? "Kirilmoqda…" : "Kirish"}
        </button>
      </form>

      {/*
        Underlined, not merely coloured. A link inside a block of text has to
        be distinguishable without colour (WCAG 1.4.1) unless it clears 3:1
        against the text around it — and measured by Lighthouse, this one was
        at **1.15:1** in dark mode (#84adff on #98a2b3). Primary against
        secondary text is a pair §13.2.2 never listed, which is P-29 arriving
        for the second time.
      */}
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        Hisobingiz yo&apos;qmi?{" "}
        <Link to="/register" className="text-(--color-primary) underline">
          Ro&apos;yxatdan o&apos;ting
        </Link>
      </p>
    </div>
  )
}
