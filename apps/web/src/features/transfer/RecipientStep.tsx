import { createRegionalPhoneSchema, DEFAULT_REGION } from "@wallet/shared"
import { Search, TriangleAlert, UserRound } from "lucide-react"
import { useState } from "react"
import { useAppDispatch } from "../../app/hooks.js"
import { FormField } from "../../components/FormField.js"
import { PhoneInput } from "../../components/PhoneInput.js"
import { messageFor } from "../../lib/fieldErrors.js"
import { useLazyLookupRecipientQuery } from "./api.js"
import { RecentRecipients } from "./RecentRecipients.js"
import { recipientChosen } from "./transferSlice.js"

/**
 * Step 1 (§13.5): who the money is for.
 *
 * Continue is enabled only once a lookup has succeeded, and that is the whole
 * design of this step. A number that merely *looks* valid is not a person:
 * letting somebody advance on nine well-formed digits means the mistake is
 * discovered on the confirmation screen at best, and after the money has gone
 * at worst.
 *
 * The lookup is deliberately manual rather than firing as the user types.
 * FR-4.9 allows twenty per hour, and a request per keystroke would spend the
 * hour's allowance on a single phone number — leaving the person unable to
 * look up the recipient they actually meant.
 */

function lookupMessage(error: unknown): string {
  const code = (error as { data?: { error?: { code?: string } } } | undefined)?.data?.error?.code

  if (code === "RECIPIENT_NOT_FOUND") return "Bu raqam bo'yicha hisob topilmadi."
  if (code === "SELF_TRANSFER_FORBIDDEN") return "O'zingizga pul yubora olmaysiz."
  // FR-4.9's cap. Naming it is the difference between "try again" — which will
  // fail the same way — and "wait".
  if (code === "RATE_LIMITED") return "Juda ko'p qidiruv. Biroz kutib, qayta urinib ko'ring."
  return "Qidirib bo'lmadi. Aloqani tekshirib, qayta urinib ko'ring."
}

export function RecipientStep() {
  const dispatch = useAppDispatch()
  const [phone, setPhone] = useState("+998")
  const [touched, setTouched] = useState(false)
  const [lookup, result] = useLazyLookupRecipientQuery()

  /*
   * The same schema the registration form uses and the server validates with
   * (§8.2). A second regex here would be a second definition of a valid
   * number, and the two would diverge on the day a new operator prefix is
   * added — in favour of whichever one was remembered.
   */
  const parsed = createRegionalPhoneSchema(DEFAULT_REGION).safeParse(phone)
  const fieldError =
    touched && !parsed.success ? messageFor(parsed.error.issues[0]?.message ?? "") : undefined

  const found = result.data

  return (
    <div className="flex flex-col gap-s">
      <FormField label="Qabul qiluvchi raqami" error={fieldError}>
        {({ id, describedBy, invalid }) => (
          <PhoneInput
            id={id}
            value={phone}
            describedBy={describedBy}
            invalid={invalid}
            onChange={(next) => {
              setPhone(next)
              // A name found for a number that has since been edited is a name
              // for somebody else. Clearing it is what stops the confirmation
              // screen showing one person beside another person's number.
              if (found) result.reset()
            }}
            onBlur={() => setTouched(true)}
          />
        )}
      </FormField>

      {/*
        13.5 step 1 asks for this beside the lookup, and it was the one part of
        that rule F4 left out. Placed under the field rather than above it: the
        number is what somebody came here to type, and a list of three is a
        shortcut rather than the primary path.
      */}
      <RecentRecipients
        onPick={(picked) => {
          setPhone(picked)
          setTouched(true)
          if (found) result.reset()
          // Looked up immediately. A pick that only fills the box leaves the
          // person to press Search on a number they did not type, which is a
          // step the shortcut exists to remove.
          void lookup(picked)
        }}
      />

      <button
        type="button"
        disabled={!parsed.success || result.isFetching}
        onClick={() => {
          setTouched(true)
          if (parsed.success) void lookup(parsed.data)
        }}
        className="flex items-center justify-center gap-2xs rounded-(--radius-control) px-s"
        style={{
          minHeight: "var(--touch-target-min)",
          background: "var(--color-surface-sunken)",
          color: "var(--color-text)",
        }}
      >
        <Search size={18} aria-hidden={true} />
        {result.isFetching ? "Qidirilmoqda…" : "Qidirish"}
      </button>

      {result.isError ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{lookupMessage(result.error)}</span>
        </p>
      ) : null}

      {found ? (
        <div
          className="flex items-center gap-s rounded-(--radius-card) p-s"
          style={{ background: "var(--color-surface-sunken)" }}
        >
          <UserRound size={20} aria-hidden={true} style={{ color: "var(--color-primary)" }} />
          <div className="flex flex-col">
            {/*
              The masked name FR-4.9 pays for — enough to recognise somebody
              you meant, not enough to enumerate strangers.
            */}
            <span className="text-step-0">{found.maskedName}</span>
            <span className="text-step--1 text-(--color-text-secondary)">{found.phone}</span>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        // §13.5 rule 1: only a found recipient advances.
        disabled={!found}
        onClick={() => {
          if (found) dispatch(recipientChosen({ phone: found.phone, maskedName: found.maskedName }))
        }}
        className="rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        Davom etish
      </button>
    </div>
  )
}
