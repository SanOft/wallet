import type { TransferDirection, TransferStatus } from "@wallet/shared"

/**
 * How an amount is allowed to look, given both what it was and whether it
 * happened.
 *
 * This exists because three screens each decided it independently and all
 * three got it the same way wrong: the colour and the sign were chosen from
 * `direction` alone, so a **failed** top-up rendered as `+ 1 000 000 so'm` in
 * success green — pixel-identical to a million so'm that actually arrived.
 * Found in a screenshot, on a row that said "Bajarilmadi" two lines above the
 * green figure.
 *
 * `RecentTransactions` even carried the comment "a failed transfer that
 * differs from a successful one only by the colour of its amount is a failed
 * transfer nobody notices", which was true and was about the status word, not
 * the amount beside it. Reasoning correctly about one half of a row is how
 * this survived review three times.
 *
 * One decision, in one place, for the same reason FR-4.9's window ended up in
 * one place (P-34): the alternative is three components that agree today.
 */

export interface AmountTone {
  /** A layer-2 token, never a raw colour (§13.2). */
  readonly colour: string
  /** Shown, not decorative: `direction` carries the sign on the wire. */
  readonly sign: "+ " | "− "
  /**
   * What a screen reader hears *for the amount itself*.
   *
   * The status is already announced in the row, and this repeats it for
   * anything that did not complete — deliberately. An amount element read on
   * its own must not say "kirim 1 000 000" about money that never arrived, and
   * a screen-reader user navigating by element hears exactly that.
   */
  readonly label: string
  /**
   * Struck through when nothing moved. The one unambiguous, non-colour signal
   * for "this did not happen" (NFR-4: colour is never the only cue).
   */
  readonly struck: boolean
}

export function amountTone(direction: TransferDirection, status: TransferStatus): AmountTone {
  const incoming = direction === "incoming"
  const sign = incoming ? ("+ " as const) : ("− " as const)
  const way = incoming ? "kirim" : "chiqim"

  if (status === "FAILED") {
    return {
      // Not danger red. The row's status word is already red, and a red amount
      // beside it reads as "you lost this", which is the opposite of true:
      // a failed transfer is money that never left.
      colour: "var(--color-text-secondary)",
      sign,
      label: `bajarilmadi, ${way} `,
      struck: true,
    }
  }

  if (status === "PENDING") {
    return {
      // Not success green: it has not arrived. Not struck either — it may yet.
      colour: "var(--color-text-secondary)",
      sign,
      label: `kutilmoqda, ${way} `,
      struck: false,
    }
  }

  return {
    colour: incoming ? "var(--color-success)" : "var(--color-text)",
    sign,
    label: `${way} `,
    struck: false,
  }
}
