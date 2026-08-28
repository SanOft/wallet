import {
  CHANNEL_LIMITS,
  createTransferAmountSchema,
  formatMoney,
  moneySchema,
} from "@wallet/shared"
import { useState } from "react"
import { useAppDispatch } from "../../app/hooks.js"
import { AmountInput } from "../../components/AmountInput.js"
import { FormField } from "../../components/FormField.js"
import { messageFor } from "../../lib/fieldErrors.js"
import { useAccountsQuery } from "../accounts/api.js"
import { amountChosen, type Recipient } from "./transferSlice.js"

/**
 * Step 2 (§13.5): how much.
 *
 * Validated on the client with the same Zod schema the server uses, so a limit
 * is met while the number is being typed rather than after a round trip
 * (§13.5 rule 2). The server still decides — the client's copy is UX, and D-4
 * spells out why: the balance can change while somebody sits on this screen,
 * so the only authority is the check that happens inside the transaction.
 *
 * **The remaining daily allowance is deliberately not shown**, although §13.5
 * asks for it. The API exposes no such figure, and the only way to compute one
 * here is to sum today's outgoing transfers from a paged history — which is
 * right until somebody makes more transfers in a day than one page holds, and
 * then it silently understates what they have spent. A wrong allowance on a
 * money screen is worse than an absent one. Recorded rather than guessed.
 */

export function AmountStep(props: { readonly recipient: Recipient }) {
  const dispatch = useAppDispatch()
  const [amount, setAmount] = useState("")
  const [touched, setTouched] = useState(false)

  const accounts = useAccountsQuery()
  const account = accounts.data?.accounts.find((candidate) => candidate.type === "USER")
  const balance = account ? BigInt(account.balance) : null

  const schema = createTransferAmountSchema("UZS")
  const parsed = schema.safeParse(amount)

  /*
   * Balance is checked here as well as in the schema, because it is not part
   * of the contract: `createTransferAmountSchema` knows the currency's minimum
   * and maximum, and only this screen knows what the person actually has.
   */
  const overBalance =
    parsed.success && balance !== null && moneySchema.safeParse(amount).success
      ? BigInt(amount) > balance
      : false

  /*
   * Shown as soon as there is something to judge, not after the field loses
   * focus. §13.5 asks for a real-time error, and it is right to: somebody
   * typing an amount they cannot afford should learn it while their attention
   * is on the number, not after they have moved on and pressed Continue.
   *
   * `touched` still gates the empty field — an error on a box nobody has typed
   * in yet is a complaint about nothing.
   */
  const shown = touched || amount.length > 0

  const error = !shown
    ? undefined
    : !parsed.success
      ? messageFor(parsed.error.issues[0]?.message ?? "")
      : overBalance
        ? "Balansda yetarli mablag' yo'q"
        : undefined

  const canContinue = parsed.success && !overBalance

  return (
    <div className="flex flex-col gap-s">
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        {props.recipient.maskedName} — {props.recipient.phone}
      </p>

      <FormField label="Summa" error={error}>
        {({ id, describedBy, invalid }) => (
          <AmountInput
            id={id}
            value={amount}
            describedBy={describedBy}
            invalid={invalid}
            onChange={setAmount}
            onBlur={() => setTouched(true)}
          />
        )}
      </FormField>

      <dl className="m-0 flex flex-col gap-3xs text-step--1 text-(--color-text-secondary)">
        <div className="flex justify-between gap-2xs">
          <dt>Balansingiz</dt>
          <dd className="tabular m-0">
            {/*
              Absent rather than zero while it loads. A balance of "0 so'm"
              shown because a request has not answered yet is the same lie the
              home screen refuses to tell.
            */}
            {balance === null ? "—" : formatMoney(balance, "UZS")}
          </dd>
        </div>
        <div className="flex justify-between gap-2xs">
          <dt>Bitta o&apos;tkazma chegarasi</dt>
          <dd className="tabular m-0">{formatMoney(CHANNEL_LIMITS.WEB.perOperation, "UZS")}</dd>
        </div>
      </dl>

      <button
        type="button"
        disabled={!canContinue}
        onClick={() => {
          setTouched(true)
          if (canContinue) dispatch(amountChosen(amount))
        }}
        className="rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        Davom etish
      </button>
    </div>
  )
}
