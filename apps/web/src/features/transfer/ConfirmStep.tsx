import { formatMoney, STEP_UP_THRESHOLD } from "@wallet/shared"
import { Send, ShieldCheck, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { useAppDispatch } from "../../app/hooks.js"
import { FormField } from "../../components/FormField.js"
import { Input } from "../../components/Input.js"
import { useOnline } from "../../lib/freshness.js"
import { enqueue, newIdempotencyKey } from "../../lib/outbox.js"
import { useCreateTransferMutation } from "./api.js"
import { type Recipient, submitRefused, submitSettled, submitStarted } from "./transferSlice.js"

/**
 * Step 3 (§13.5): everything on one card, and the last chance to stop.
 *
 * Two protections against a double tap, and they are not redundant. The button
 * dies the moment `submitting` is set — but a fast double tap can outrun a
 * React render, so the idempotency key is what makes the second request
 * harmless. S-6 asks for both because either alone leaves a gap: the key
 * without the lock sends two requests, and the lock without the key means the
 * one that slipped through creates a second transfer.
 *
 * The key is minted when this screen opens, not when Send is pressed. A key
 * created per press is a fresh key per press, which is exactly what the
 * pairing is meant to prevent.
 */

function refusalMessage(code: string | undefined): string {
  switch (code) {
    case "INSUFFICIENT_FUNDS":
      return "Balansda yetarli mablag' yo'q."
    case "LIMIT_EXCEEDED":
      return "Bu summa chegaradan oshadi."
    case "STEP_UP_FAILED":
      return "Parol noto'g'ri."
    case "STEP_UP_REQUIRED":
      return "Bu summa uchun parolni kiriting."
    // The step-up shares the sign-in's backoff, so a few wrong passwords here
    // lock this screen and the login alike. Saying "wait" rather than "wrong"
    // is what stops somebody typing the same password four more times.
    case "AUTH_LOCKED":
      return "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring."
    case "RECIPIENT_NOT_FOUND":
      return "Qabul qiluvchi topilmadi."
    case "SELF_TRANSFER_FORBIDDEN":
      return "O'zingizga pul yubora olmaysiz."
    default:
      return "O'tkazmani bajarib bo'lmadi."
  }
}

/** A failure that never reached a server, and so can be queued (FR-8.4). */
function neverArrived(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === "number") return status >= 500
  return status === "FETCH_ERROR" || status === "TIMEOUT_ERROR"
}

export function ConfirmStep(props: {
  readonly recipient: Recipient
  readonly amount: string
  readonly submitting: boolean
}) {
  const { recipient, amount, submitting } = props
  const dispatch = useAppDispatch()
  const online = useOnline()
  const [send] = useCreateTransferMutation()
  const [password, setPassword] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)

  // One key for this confirmation, however many times Send is pressed.
  const [idempotencyKey] = useState(newIdempotencyKey)

  const needsStepUp = BigInt(amount) > STEP_UP_THRESHOLD

  return (
    <div className="flex flex-col gap-s">
      <dl
        className="m-0 flex flex-col gap-2xs rounded-(--radius-card) p-m"
        style={{ background: "var(--color-surface-sunken)" }}
      >
        <div className="flex justify-between gap-2xs">
          <dt className="text-step--1 text-(--color-text-secondary)">Qabul qiluvchi</dt>
          <dd className="m-0 text-step-0">{recipient.maskedName}</dd>
        </div>
        <div className="flex justify-between gap-2xs">
          <dt className="text-step--1 text-(--color-text-secondary)">Raqam</dt>
          <dd className="tabular m-0 text-step-0">{recipient.phone}</dd>
        </div>
        <div className="flex justify-between gap-2xs">
          <dt className="text-step--1 text-(--color-text-secondary)">Summa</dt>
          <dd className="tabular m-0 text-step-2">{formatMoney(BigInt(amount), "UZS")}</dd>
        </div>
      </dl>

      {needsStepUp ? (
        <div className="flex flex-col gap-2xs">
          <p
            className="m-0 flex items-start gap-2xs text-step--1"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <ShieldCheck size={16} aria-hidden={true} className="mt-3xs shrink-0" />
            {/*
              The reason, not just the field. FR-2.8 asks for a password on a
              large transfer, and a password box with no explanation on a
              confirmation screen is what a phishing page looks like.
            */}
            <span>
              {formatMoney(STEP_UP_THRESHOLD, "UZS")}dan katta o&apos;tkazma uchun parolingizni
              tasdiqlang.
            </span>
          </p>

          <FormField label="Parol">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                enterKeyHint="send"
                value={password}
                aria-describedby={describedBy}
                invalid={invalid}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </FormField>
        </div>
      ) : null}

      {refusal ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{refusal}</span>
        </p>
      ) : null}

      <button
        type="button"
        // S-6's first layer. The key is the second.
        disabled={submitting}
        onClick={async () => {
          setRefusal(null)
          dispatch(submitStarted())

          const request = {
            phone: recipient.phone,
            amount,
            idempotencyKey,
            ...(needsStepUp ? { password } : {}),
          }

          /*
           * A transfer large enough to need a password is not queued at all.
           *
           * A queued request must never carry a credential into IndexedDB, so
           * a step-up transfer written to the outbox would arrive at the
           * server without one and be refused — a guaranteed failure, stored,
           * retried, and reported as a failure some minutes later. Saying so
           * now costs the user one sentence; the alternative costs them the
           * belief that a queued transfer will happen.
           */
          if (!online && needsStepUp) {
            setRefusal(
              "Bu summadagi o'tkazma uchun aloqa kerak — parolni faqat serverga yuborib tasdiqlash mumkin.",
            )
            dispatch(submitRefused())
            return
          }

          /*
           * Anything smaller goes to the outbox, exactly as a top-up does
           * (§11.6), and drains with the same key.
           */
          if (!online) {
            await enqueue({
              key: idempotencyKey,
              kind: "transfer",
              body: { phone: recipient.phone, amount },
              status: "queued",
              attempts: 0,
              queuedAt: Date.now(),
            })
            dispatch(submitSettled({ kind: "queued" }))
            return
          }

          const result = await send(request)

          if (!("error" in result)) {
            dispatch(submitSettled({ kind: "completed", transferId: result.data.id }))
            return
          }

          if (neverArrived(result.error)) {
            await enqueue({
              key: idempotencyKey,
              kind: "transfer",
              body: { phone: recipient.phone, amount },
              status: "queued",
              attempts: 1,
              queuedAt: Date.now(),
            })
            dispatch(submitSettled({ kind: "queued" }))
            return
          }

          const code = (result.error as { data?: { error?: { code?: string } } }).data?.error?.code

          /*
           * A refusal the user can act on keeps them here with a live button —
           * a wrong password or an amount over a limit is a thing to change
           * and try again, not an outcome to be shown a result screen about.
           */
          setRefusal(refusalMessage(code))
          dispatch(submitRefused())
        }}
        className="flex items-center justify-center gap-2xs rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        <Send size={18} aria-hidden={true} />
        {submitting ? "Yuborilmoqda…" : "Yuborish"}
      </button>
    </div>
  )
}
