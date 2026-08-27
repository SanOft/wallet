import { CURRENCIES } from "@wallet/shared"
import { Input } from "./Input.js"

/**
 * Digits in, minor units out.
 *
 * `type="text"` with `inputmode="numeric"`, never `type="number"`. web.dev is
 * direct about why for money: the spinner arrows are meaningless on an amount,
 * a scroll wheel over the field silently changes it, and browsers accept `1e5`
 * and `-` as valid input. The numeric keypad is what was actually wanted, and
 * `inputmode` gives that without the rest.
 *
 * The user types so'm; the form holds tiyin. UZS has `exponent: 2` and
 * `displayDecimals: 0` — a tiyin is a hundredth of a so'm, and nobody writes
 * them — so 1 250 000 so'm is carried as "125000000". Both numbers come from
 * the registry, because they are not the same number and only one of them is
 * about the keyboard.
 */

const UZS = CURRENCIES.UZS
const SCALE = "0".repeat(UZS.exponent)

/** Leading zeros dropped: "007" is the same amount as "7" and looks like a bug. */
export function majorDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "")
  return digits === "0" ? "" : digits
}

/** `1250000` → `1 250 000`, grouped as the user types (§13.8.1). */
export function displayAmount(major: string): string {
  return major.replace(/\B(?=(\d{3})+(?!\d))/g, UZS.groupSeparator)
}

/** `"1250000"` so'm → `"125000000"` tiyin, which is what `moneySchema` parses. */
export function toMinor(major: string): string {
  return major === "" ? "" : `${major}${SCALE}`
}

export function AmountInput(props: {
  readonly id: string
  /** Minor units, as the form holds it. */
  readonly value: string
  readonly describedBy: string | undefined
  readonly invalid: boolean
  readonly onChange: (minor: string) => void
  readonly onBlur: () => void
}) {
  const major = props.value.length > UZS.exponent ? props.value.slice(0, -UZS.exponent) : ""

  return (
    <div className="flex items-center gap-2xs">
      <Input
        id={props.id}
        type="text"
        inputMode="numeric"
        autoComplete="transaction-amount"
        enterKeyHint="next"
        value={displayAmount(major)}
        aria-describedby={props.describedBy}
        invalid={props.invalid}
        onChange={(event) => props.onChange(toMinor(majorDigits(event.target.value)))}
        onBlur={props.onBlur}
      />
      {/* Outside the input: inside it, the currency would be selectable text a
          user can delete, and screen readers would read it as part of the value. */}
      <span aria-hidden="true" className="text-(--color-text-secondary)">
        {UZS.symbol}
      </span>
    </div>
  )
}
