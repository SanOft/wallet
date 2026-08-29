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
 * All three figures §13.5 asks for are shown, and all three are enforced here
 * rather than only by the server. The daily allowance arrives with the accounts
 * response (P-32) from the same function that would refuse the transfer — it
 * used to be absent because the only client-side route to it was summing a
 * paged history, which silently understates spending past the first page.
 */

export function AmountStep(props: { readonly recipient: Recipient }) {
  const dispatch = useAppDispatch()
  const [amount, setAmount] = useState("")
  const [touched, setTouched] = useState(false)

  const accounts = useAccountsQuery()
  const account = accounts.data?.accounts.find((candidate) => candidate.type === "USER")
  const balance = account ? BigInt(account.balance) : null
  const remainingDaily = accounts.data ? BigInt(accounts.data.limits.daily.remaining) : null

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
   * Over the daily allowance is refused here rather than by the server, for the
   * same reason `overBalance` is: a client that can see the rule and lets the
   * user press Send anyway spends a round trip to say no, and the wizard has
   * already moved on by the time it lands.
   *
   * `null` while it loads means *not blocked*: an unknown allowance must not
   * refuse a legitimate transfer, and the server still holds the real gate.
   */
  const overDaily =
    parsed.success && remainingDaily !== null && moneySchema.safeParse(amount).success
      ? BigInt(amount) > remainingDaily
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
        : overDaily
          ? "Bugungi chegaradan oshdi"
          : undefined

  const canContinue = parsed.success && !overBalance && !overDaily

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
        <div className="flex justify-between gap-2xs">
          <dt>Bugungi qolgan chegara</dt>
          <dd className="tabular m-0">
            {/*
              13.5 asked for this and F4 shipped without it, because the only
              client-side route to a figure was summing a paged history — right
              until somebody exceeds one page in a day and silently wrong after
              that (P-32). The server returns it now, computed by the same
              function that would refuse the transfer.

              An em dash rather than the full limit while it loads, for the same
              reason the balance above shows one: a number that is not yet known
              must not be rendered as a number that is.
            */}
            {remainingDaily === null ? "—" : formatMoney(remainingDaily, "UZS")}
          </dd>
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
