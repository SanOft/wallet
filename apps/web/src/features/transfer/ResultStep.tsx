import { formatMoney } from "@wallet/shared"
import { CircleCheck, CircleX, Clock } from "lucide-react"
import { Link } from "react-router"
import { useAppDispatch } from "../../app/hooks.js"
import { type Recipient, type TransferOutcome, wizardReset } from "./transferSlice.js"

/**
 * Step 4 (§13.5): what happened, and what to do about it.
 *
 * Three outcomes and three different pieces of advice. "Queued" is not a
 * success and is not a failure — the money has not moved and the request has
 * not been refused — and collapsing it into either would be the screen
 * claiming something it does not know.
 *
 * There is no way back to the confirmation from here. The money has moved or
 * it has not, and the previous screen no longer describes anything true.
 */

const ADVICE: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Balansni to'ldirib, qayta urinib ko'ring.",
  LIMIT_EXCEEDED: "Kamroq summa bilan urinib ko'ring yoki ertaga davom eting.",
  RECIPIENT_NOT_FOUND: "Raqamni tekshirib, qaytadan qidiring.",
  SELF_TRANSFER_FORBIDDEN: "Boshqa raqamni tanlang.",
  STEP_UP_FAILED: "Parolni tekshirib, qaytadan yuboring.",
}

export function ResultStep(props: {
  readonly recipient: Recipient
  readonly amount: string
  readonly outcome: TransferOutcome
}) {
  const { recipient, amount, outcome } = props
  const dispatch = useAppDispatch()

  const view =
    outcome.kind === "completed"
      ? { Icon: CircleCheck, token: "--color-success", title: "Yuborildi" }
      : outcome.kind === "queued"
        ? { Icon: Clock, token: "--color-neutral", title: "Navbatga qo'yildi" }
        : { Icon: CircleX, token: "--color-danger", title: "Yuborilmadi" }

  return (
    <div className="flex flex-col items-center gap-s py-l text-center">
      <view.Icon size={48} aria-hidden={true} style={{ color: `var(${view.token})` }} />

      {/*
        `alert`, because this is the answer to something the user did and they
        may be about to leave the screen. The heading carries the outcome in
        words, so the icon and its colour are never the only signal.
      */}
      <h2 role="alert" className="m-0 text-step-2">
        {view.title}
      </h2>

      <p className="tabular m-0 text-step-1">{formatMoney(BigInt(amount), "UZS")}</p>
      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        {recipient.maskedName} — {recipient.phone}
      </p>

      {outcome.kind === "queued" ? (
        <p className="m-0 text-step--1" style={{ color: "var(--color-neutral)" }}>
          {/*
            Deliberately not "sent". Nothing has moved, and the home screen
            shows it in the queue until it has.
          */}
          Aloqa tiklanganda yuboriladi. Holatini asosiy ekranda kuzatib borasiz.
        </p>
      ) : null}

      {outcome.kind === "failed" ? (
        <p className="m-0 text-step--1" style={{ color: "var(--color-danger)" }}>
          {ADVICE[outcome.code] ?? "Qayta urinib ko'ring yoki keyinroq harakat qiling."}
        </p>
      ) : null}

      {outcome.kind === "completed" ? (
        <p className="m-0 text-step--1 text-(--color-text-secondary)">
          {/* For support (FR-5.3): the one thing that identifies this transfer. */}
          Amaliyot raqami: <span className="tabular">{outcome.transferId}</span>
        </p>
      ) : null}

      <Link
        to="/"
        onClick={() => dispatch(wizardReset())}
        className="mt-s flex w-full items-center justify-center rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        Asosiyga qaytish
      </Link>
    </div>
  )
}
