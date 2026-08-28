import { DEMO_TOPUP_AMOUNT, DEMO_TOPUP_MAX_PER_DAY, formatMoney } from "@wallet/shared"
import { CirclePlus, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { useTopUpMutation } from "./api.js"

/**
 * FR-10's demo top-up.
 *
 * The button is disabled only while the request is in flight, never because
 * the state looks wrong (§13.8.2) — and that disabling is doing real work
 * here rather than being politeness. S-6 pairs it with the idempotency key:
 * the key makes a double-tap harmless on the server, and this makes the second
 * tap not happen. Either alone leaves a gap; the key is the one that matters,
 * because a fast double-tap can outrun a React render.
 */

const LIMIT_MESSAGE = `Kuniga ${DEMO_TOPUP_MAX_PER_DAY} martagacha to'ldirish mumkin. Ertaga qayta urinib ko'ring.`

function messageFor(error: unknown): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code

  // FR-10.3's cap is the expected failure, and it needs its own sentence: "try
  // again" is wrong advice for a limit that resets tomorrow.
  if (code === "LIMIT_EXCEEDED") return LIMIT_MESSAGE
  return "To'ldirib bo'lmadi. Qayta urinib ko'ring."
}

export function TopUpButton() {
  const [topUp, request] = useTopUpMutation()
  const [failure, setFailure] = useState<string | null>(null)

  const amount = formatMoney(DEMO_TOPUP_AMOUNT, "UZS")

  return (
    <div className="flex flex-col gap-2xs">
      <button
        type="button"
        disabled={request.isLoading}
        onClick={async () => {
          setFailure(null)
          const result = await topUp()
          if ("error" in result) setFailure(messageFor(result.error))
        }}
        className="flex items-center justify-center gap-2xs rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        <CirclePlus size={18} aria-hidden={true} />
        {/*
          The amount is in the label, not only in the confirmation. A button
          that says "top up" and then moves a million so'm has decided
          something on the user's behalf.
        */}
        {request.isLoading ? "To'ldirilmoqda…" : `Demo to'ldirish — ${amount}`}
      </button>

      {failure ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{failure}</span>
        </p>
      ) : null}
    </div>
  )
}
