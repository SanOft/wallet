import { Input } from "./Input.js"

/**
 * Four digits, hidden, and never remembered.
 *
 * §13.8.1: `type="password"` so a shoulder cannot read it, `inputmode="numeric"`
 * for the keypad, and `autocomplete="off"` — the one field in this app where
 * that is correct. A password manager storing a device PIN would defeat the
 * point of having a second factor on the device at all.
 *
 * One field rather than four boxes, for the same reason the phone number is
 * one field: four inputs break paste, fight the caret, and announce themselves
 * to a screen reader as four unrelated things.
 */

export const PIN_LENGTH = 4

export function PinInput(props: {
  readonly id: string
  readonly value: string
  readonly describedBy: string | undefined
  readonly invalid: boolean
  readonly label?: string
  readonly onChange: (pin: string) => void
  readonly onBlur: () => void
}) {
  return (
    <Input
      id={props.id}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      enterKeyHint="done"
      maxLength={PIN_LENGTH}
      value={props.value}
      aria-describedby={props.describedBy}
      aria-label={props.label}
      invalid={props.invalid}
      onChange={(event) =>
        props.onChange(event.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))
      }
      onBlur={props.onBlur}
    />
  )
}
