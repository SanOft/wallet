import { DEMO_TOPUP_AMOUNT, formatMoney } from "@wallet/shared"
import { CircleAlert, Clock } from "lucide-react"
import type { OutboxItem } from "../../lib/outbox.js"
import { useOutbox } from "./useOutbox.js"

/**
 * §11.6's queued badge: what has been asked for and has not happened yet.
 *
 * Placed above the real transactions rather than mixed into them, because
 * these are not transactions. Nothing has moved, no ledger entry exists, and a
 * queued item rendered like a completed one would be the screen claiming a
 * payment the server has never heard of.
 *
 * The neutral colour is the one §13.2.2 reserves for QUEUED, and the word is
 * there too — a grey row and a black row are the same row to anyone who cannot
 * distinguish them.
 */

/** Why a queued item stopped, in language that says what to do about it. */
const REASON: Record<string, string> = {
  LIMIT_EXCEEDED: "Kunlik limit tugagan. Ertaga qayta urinib ko'ring.",
  exhausted: "Bir necha marta urinildi, yuborilmadi. Qayta urinib ko'ring.",
  IDEMPOTENCY_CONFLICT: "Bu so'rov allaqachon boshqa ma'lumot bilan yuborilgan.",
  AUTH_TOKEN_EXPIRED: "Sessiya tugagan. Qaytadan kiring.",
}

function reasonFor(code: string | undefined): string {
  // An unrecognised code is shown as itself rather than as a shrug: a support
  // conversation that starts with a real code is shorter than one that starts
  // with "something went wrong".
  return code ? (REASON[code] ?? `Yuborilmadi (${code})`) : "Yuborilmadi."
}

function Row(props: { readonly item: OutboxItem }) {
  const { item } = props
  const failed = item.status === "failed"
  const Icon = failed ? CircleAlert : Clock

  return (
    <li className="flex items-center gap-s py-2xs">
      <Icon
        size={20}
        aria-hidden={true}
        className="shrink-0"
        style={{ color: failed ? "var(--color-danger)" : "var(--color-neutral)" }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-step-0" style={{ color: "var(--color-text-secondary)" }}>
          Demo to&apos;ldirish
        </span>
        <span
          className="text-step--1"
          style={{ color: failed ? "var(--color-danger)" : "var(--color-neutral)" }}
        >
          {/*
            The state in words, not only in colour. "Navbatda" and
            "Yuborilmadi" are opposite outcomes and must not depend on a hue to
            be told apart.
          */}
          {failed ? reasonFor(item.failReason) : "Navbatda — yuborilmagan"}
        </span>
      </div>

      <span
        className="tabular shrink-0 text-step-0"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {formatMoney(DEMO_TOPUP_AMOUNT, "UZS")}
      </span>
    </li>
  )
}

export function QueuedList() {
  const { queued } = useOutbox()

  if (queued.length === 0) return null

  return (
    <section aria-labelledby="queued-heading" className="flex flex-col gap-2xs">
      <h2 id="queued-heading" className="m-0 text-step-1">
        Yuborilmaganlar
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {queued.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </ul>
    </section>
  )
}
