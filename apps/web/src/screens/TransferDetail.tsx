import { formatMoney, type HistoryItem } from "@wallet/shared"
import { ArrowLeft, TriangleAlert } from "lucide-react"
import { Link, useParams } from "react-router"
import { Skeleton } from "../components/Skeleton.js"
import { useOneTransferQuery } from "../features/history/api.js"
import { amountTone } from "../lib/amountTone.js"
import { formatWhen } from "../lib/datetime.js"

/**
 * FR-5.3's detail, reachable from a link rather than only from the list.
 *
 * It has its own endpoint for that reason. Rendering the row the list already
 * holds would be cheaper and would break on the two occasions it matters most:
 * a reload, and a link somebody pasted into a support conversation.
 */

const STATUS: Record<HistoryItem["status"], { text: string; token: string }> = {
  COMPLETED: { text: "Bajarildi", token: "--color-success" },
  PENDING: { text: "Kutilmoqda", token: "--color-warning" },
  FAILED: { text: "Bajarilmadi", token: "--color-danger" },
}

export function TransferDetail() {
  const { id } = useParams()
  const query = useOneTransferQuery(id ?? "")
  const item = query.data

  return (
    <div className="flex flex-col gap-l">
      <header className="flex items-center gap-s">
        <Link
          to="/history"
          aria-label="Orqaga"
          className="flex shrink-0 items-center justify-center rounded-(--radius-control)"
          style={{
            minWidth: "var(--touch-target-min)",
            minHeight: "var(--touch-target-min)",
            color: "inherit",
          }}
        >
          <ArrowLeft size={20} aria-hidden={true} />
        </Link>
        <h1 className="m-0 text-step-3">Amaliyot</h1>
      </header>

      {query.isLoading ? <Skeleton width="100%" height="var(--text-step-4)" /> : null}

      {query.isError ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          {/*
            One message for "no such transfer" and "not yours". The server
            answers them identically so this cannot be an oracle for which ids
            exist, and a screen that guessed which had happened would undo
            that.
          */}
          <span>Bu amaliyot topilmadi.</span>
        </p>
      ) : null}

      {item ? (
        <>
          <p
            className="tabular m-0 text-step-4"
            style={{
              color: amountTone(item.direction, item.status).colour,
              textDecoration: amountTone(item.direction, item.status).struck
                ? "line-through"
                : undefined,
            }}
          >
            <span aria-hidden="true">{item.direction === "incoming" ? "+ " : "− "}</span>
            <span className="sr-only">{item.direction === "incoming" ? "kirim " : "chiqim "}</span>
            {formatMoney(BigInt(item.amount), "UZS")}
          </p>

          <dl
            className="m-0 flex flex-col gap-2xs rounded-(--radius-card) p-m"
            style={{ background: "var(--color-surface-sunken)" }}
          >
            <div className="flex justify-between gap-2xs">
              <dt className="text-step--1 text-(--color-text-secondary)">Holat</dt>
              <dd
                className="m-0 text-step-0"
                style={{ color: `var(${STATUS[item.status].token})` }}
              >
                {STATUS[item.status].text}
              </dd>
            </div>
            <div className="flex justify-between gap-2xs">
              <dt className="text-step--1 text-(--color-text-secondary)">Kim bilan</dt>
              <dd className="m-0 text-step-0">
                {item.counterparty?.maskedName ?? "Demo to'ldirish"}
              </dd>
            </div>
            <div className="flex justify-between gap-2xs">
              <dt className="text-step--1 text-(--color-text-secondary)">Sana</dt>
              <dd className="m-0 text-step-0">{formatWhen(item.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-2xs">
              <dt className="text-step--1 text-(--color-text-secondary)">Kanal</dt>
              <dd className="m-0 text-step-0">{item.channel}</dd>
            </div>
            <div className="flex flex-col gap-3xs">
              <dt className="text-step--1 text-(--color-text-secondary)">Amaliyot raqami</dt>
              {/* FR-5.3: the one thing support will ask for. */}
              <dd className="tabular m-0 text-step--1">{item.id}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </div>
  )
}
