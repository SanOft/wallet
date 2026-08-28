import { ArrowLeft } from "lucide-react"
import { useNavigate } from "react-router"
import { useAppDispatch, useAppSelector } from "../app/hooks.js"
import { AmountStep } from "../features/transfer/AmountStep.js"
import { ConfirmStep } from "../features/transfer/ConfirmStep.js"
import { RecipientStep } from "../features/transfer/RecipientStep.js"
import { ResultStep } from "../features/transfer/ResultStep.js"
import { steppedBack, wizardReset } from "../features/transfer/transferSlice.js"

/**
 * §13.5's wizard, assembled.
 *
 * The step is read from Redux rather than from the URL, and that is the
 * decision §13.5 makes for us: wizard state is lost on reload, deliberately,
 * so a half-finished money operation is never restored. Putting the step in
 * the path would make it restorable — and a person returning to
 * `/transfer/confirm` an hour later would be looking at a confirmation for an
 * amount they no longer remember choosing.
 */

const TITLES = {
  recipient: "Kimga",
  amount: "Qancha",
  confirm: "Tasdiqlash",
  result: "Natija",
} as const

export function Transfer() {
  const step = useAppSelector((state) => state.transfer.step)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const canGoBack = step.name === "amount" || step.name === "confirm"

  return (
    <div className="flex flex-col gap-l">
      <header className="flex items-center gap-s">
        {step.name === "result" ? null : (
          <button
            type="button"
            onClick={() => {
              if (canGoBack) {
                dispatch(steppedBack())
                return
              }

              /*
               * Leaving from the first step throws nothing away, so there is
               * nothing to confirm. §13.5 asks for a confirmation on cancel;
               * it belongs where something would be lost, and the later steps
               * reach it through `steppedBack` instead.
               */
              dispatch(wizardReset())
              void navigate("/")
            }}
            aria-label={canGoBack ? "Orqaga" : "Bekor qilish"}
            className="flex shrink-0 items-center justify-center rounded-(--radius-control)"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
          >
            <ArrowLeft size={20} aria-hidden={true} />
          </button>
        )}

        <h1 className="m-0 text-step-3">{TITLES[step.name]}</h1>
      </header>

      {step.name === "recipient" ? <RecipientStep /> : null}
      {step.name === "amount" ? <AmountStep recipient={step.recipient} /> : null}
      {step.name === "confirm" ? (
        <ConfirmStep recipient={step.recipient} amount={step.amount} submitting={step.submitting} />
      ) : null}
      {step.name === "result" ? (
        <ResultStep recipient={step.recipient} amount={step.amount} outcome={step.outcome} />
      ) : null}
    </div>
  )
}
