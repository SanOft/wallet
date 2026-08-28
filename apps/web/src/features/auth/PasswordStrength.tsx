import { PASSWORD_MIN_LENGTH } from "@wallet/shared"

/**
 * Length, and nothing else — §13.4 says so with an exclamation mark.
 *
 * Composition rules ("one uppercase, one digit, one symbol") are the reason
 * `Password1!` exists. They shrink the search space by making the pattern
 * predictable, they push people toward reuse because the rule differs on every
 * site, and they defeat the password managers that would otherwise generate
 * something genuinely random. NIST dropped them in 800-63B; the schema in
 * `packages/shared` never had them, and this meter must not reintroduce them
 * through the back door by rewarding a symbol.
 *
 * The bands are advice, not a gate. The only rule enforced anywhere is the
 * minimum, and it is enforced by the schema both sides share.
 */

interface Band {
  readonly upTo: number
  readonly label: string
  readonly token: string
  /** Filled segments out of three, so the bar is not the only signal. */
  readonly filled: number
}

/**
 * Named rather than indexed, so the unbounded band is reachable without an
 * assertion: `BANDS.at(-1)!` would tell the type checker to trust a claim the
 * array's type does not actually make.
 */
const STRONG: Band = {
  upTo: Number.POSITIVE_INFINITY,
  label: "Kuchli",
  token: "--color-success",
  filled: 3,
}

const BANDS: readonly Band[] = [
  { upTo: PASSWORD_MIN_LENGTH - 1, label: "Juda qisqa", token: "--color-danger", filled: 1 },
  { upTo: PASSWORD_MIN_LENGTH + 4, label: "Yetarli", token: "--color-warning", filled: 2 },
  STRONG,
]

function bandFor(length: number): Band {
  // Ordered, and `STRONG` is unbounded, so the fallback is unreachable in fact
  // — it is here to make that unreachability provable rather than asserted.
  return BANDS.find((band) => length <= band.upTo) ?? STRONG
}

export function PasswordStrength(props: { readonly value: string }) {
  const length = [...props.value].length
  const band = bandFor(length)

  if (length === 0) return null

  return (
    <div className="flex items-center gap-2xs">
      <div aria-hidden="true" className="flex flex-1 gap-3xs">
        {[0, 1, 2].map((segment) => (
          <span
            key={segment}
            className="h-3xs flex-1 rounded-(--radius-control)"
            style={{
              /*
               * The unfilled segments were `--color-surface-sunken`, which is
               * one step off the page background — so on a short password the
               * meter showed a single red stub with nothing behind it, and the
               * scale it is measured against was invisible. A track has to be
               * seen to mean anything.
               *
               * Mixed down rather than a flat grey: at full strength the track
               * reads as a fourth filled segment.
               */
              background:
                segment < band.filled
                  ? `var(${band.token})`
                  : "color-mix(in oklab, var(--color-neutral) 35%, transparent)",
            }}
          />
        ))}
      </div>

      {/*
        The bar is decorative; this is the message. A meter that says its
        verdict only in colour says nothing to a colour-blind reader and
        nothing at all to a screen reader.

        `role="status"` rather than `alert`: it changes on every keystroke, and
        an assertive region would interrupt the typing it is describing.
      */}
      <span role="status" className="text-step--1 text-(--color-text-secondary)">
        {band.label}
        <span className="sr-only">{` — ${length} belgi, kamida ${PASSWORD_MIN_LENGTH} kerak`}</span>
      </span>
    </div>
  )
}
