import { DEMO_TOPUP_AMOUNT, DEMO_TOPUP_MAX_PER_DAY, formatMoney } from "@wallet/shared"
import { CirclePlus, Clock, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { useOnline } from "../../lib/freshness.js"
import { enqueue, newIdempotencyKey, queuedItems, watchOutbox } from "../../lib/outbox.js"
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

/**
 * Did this failure come from the server at all?
 *
 * RTK Query reports a transport failure as `status: "FETCH_ERROR"` and a
 * server one as a number. The distinction is the whole of FR-8.4: a refusal is
 * final, and a request that never arrived is the ordinary case this queue was
 * built for.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === "number") return status >= 500
  return status === "FETCH_ERROR" || status === "TIMEOUT_ERROR"
}

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
  /** The key this button queued, if it is still waiting. */
  const [queuedKey, setQueuedKey] = useState<string | null>(null)
  const online = useOnline()

  const amount = formatMoney(DEMO_TOPUP_AMOUNT, "UZS")

  /*
   * The notice says "it will be sent when the connection returns", so it has
   * to stop saying that once it has been sent. Left alone it sits under a
   * balance that has already changed, describing a future for something in the
   * past — a small lie, but the same kind as every other one this screen is
   * built to avoid.
   */
  useEffect(() => {
    if (!queuedKey) return

    const check = async () => {
      const items = await queuedItems()
      if (!items.some((item) => item.key === queuedKey)) setQueuedKey(null)
    }

    void check()
    return watchOutbox(() => {
      void check()
    })
  }, [queuedKey])

  return (
    <div className="flex flex-col gap-2xs">
      <button
        type="button"
        disabled={request.isLoading}
        onClick={async () => {
          setFailure(null)
          setQueuedKey(null)

          /*
           * §11.6: the key is made once, here, and belongs to this attempt
           * whether it is sent now or in an hour. Everything after this point
           * can be retried without becoming a second top-up.
           */
          const key = newIdempotencyKey()
          const item = {
            key,
            kind: "topup" as const,
            body: {},
            status: "queued" as const,
            attempts: 0,
            queuedAt: Date.now(),
          }

          // Offline: straight to the queue, without a request nobody can send.
          if (!online) {
            await enqueue(item)
            setQueuedKey(key)
            return
          }

          const result = await topUp({ idempotencyKey: key })
          if (!("error" in result)) return

          /*
           * A failure that could not have been the server's answer goes to the
           * queue rather than to the user. §11.6 sends a direct attempt into
           * the same result switch as a queued one, and "no status at all"
           * means the request never arrived — the case the outbox exists for.
           */
          if (isRetryable(result.error)) {
            await enqueue({ ...item, attempts: 1 })
            setQueuedKey(key)
            return
          }

          setFailure(messageFor(result.error))
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

      {queuedKey ? (
        <p
          role="status"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-neutral)" }}
        >
          <Clock size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          {/*
            Not "done". The money has not moved, and saying so now would be a
            promise made on behalf of a request that has not been sent.
          */}
          <span>Navbatga qo&apos;yildi. Aloqa tiklanganda yuboriladi.</span>
        </p>
      ) : null}

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
