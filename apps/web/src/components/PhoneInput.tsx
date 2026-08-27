import { REGIONS } from "@wallet/shared"
import { Input } from "./Input.js"

/**
 * One field, masked for reading and stored as E.164.
 *
 * web.dev's payment-form guidance is explicit that a phone number is a single
 * input: splitting it into country/area/number boxes breaks paste, breaks
 * autofill, and makes the caret jump between elements. So the mask is display
 * only — `+998 90 123 45 67` is what the user sees, `+998901234567` is what
 * the form holds and what `phoneSchema` validates.
 *
 * That also settles D-7: a number pasted as `+998 (90) 123-45-67` loses its
 * separators here rather than being reported as invalid, because the digits
 * were never in doubt.
 */

const { callingCode, nationalNumberLength, displayGroups } = REGIONS.UZ

/** Digits the user actually supplied, with the calling code removed. */
export function nationalDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "")
  const withoutCode = digits.startsWith(callingCode) ? digits.slice(callingCode.length) : digits
  return withoutCode.slice(0, nationalNumberLength)
}

/** Progressive: the groups fill as they are typed rather than appearing at the end. */
export function displayPhone(national: string): string {
  const parts: string[] = []
  let index = 0
  for (const size of displayGroups) {
    if (index >= national.length) break
    parts.push(national.slice(index, index + size))
    index += size
  }
  return parts.length > 0 ? `+${callingCode} ${parts.join(" ")}` : `+${callingCode}`
}

export function PhoneInput(props: {
  readonly id: string
  readonly value: string
  readonly describedBy: string | undefined
  readonly invalid: boolean
  readonly onChange: (e164: string) => void
  readonly onBlur: () => void
}) {
  const national = nationalDigits(props.value)

  return (
    <Input
      id={props.id}
      // §13.8.1: `tel` brings up the phone keypad and tells autofill what this
      // is. `inputmode` is left alone — `type="tel"` already implies it.
      type="tel"
      autoComplete="tel"
      enterKeyHint="next"
      value={displayPhone(national)}
      aria-describedby={props.describedBy}
      invalid={props.invalid}
      onChange={(event) => {
        const digits = nationalDigits(event.target.value)
        // Always a `+998…` string, complete or not. An incomplete one fails
        // `phoneSchema`, which is what produces "9 ta raqam" on blur — a
        // half-typed number is not a different kind of value.
        props.onChange(`+${callingCode}${digits}`)
      }}
      onBlur={props.onBlur}
    />
  )
}
