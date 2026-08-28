import { formatMoney, type HistoryItem, historyResponseSchema } from "@wallet/shared"
import { ArrowDownLeft, ArrowUpRight, Clock, TriangleAlert } from "lucide-react"
import { Link } from "react-router"
import { FreshnessLine } from "../../components/Freshness.js"
import { Skeleton } from "../../components/Skeleton.js"
import { formatWhen } from "../../lib/datetime.js"
import { useCachedQuery } from "../../lib/useCachedQuery.js"
import { RECENT_COUNT, useRecentTransfersQuery } from "./api.js"

/**
 * The last few movements (§13.3), which is the answer to "where did my money
 * go" — the question people actually open a wallet to ask.
 *
 * Every row says what happened in words as well as in colour and arrows.
 * Direction is the sign, status is a word, and a failed transfer is never a
 * red row that a colour-blind reader sees as an ordinary one.
 */

/**
 * Keys for the placeholder rows, computed once.
 *
 * Derived from `RECENT_COUNT` so the two cannot drift, but computed here
 * rather than in the render: a key taken from an array index is a key that
 * changes meaning when the array does, and while placeholders never reorder,
 * the rule that objects to it is right often enough to be worth arranging the
 * code around instead of suppressing.
 */
const SKELETON_KEYS = Array.from({ length: RECENT_COUNT }, (_, index) => `skeleton-${index}`)

const STATUS: Record<HistoryItem["status"], { readonly text: string; readonly token: string }> = {
  COMPLETED: { text: "Bajarildi", token: "--color-success" },
  PENDING: { text: "Kutilmoqda", token: "--color-warning" },
  FAILED: { text: "Bajarilmadi", token: "--color-danger" },
}

function Row(props: { readonly item: HistoryItem }) {
  const { item } = props
  const incoming = item.direction === "incoming"
  const Arrow = incoming ? ArrowDownLeft : ArrowUpRight
  const status = STATUS[item.status]

  /*
   * The counterparty is null for a top-up, where the other side is the
   * treasury. Naming it would be describing plumbing; "Demo to'ldirish" is
   * what the user did.
   */
  const who = item.counterparty?.maskedName ?? "Demo to'ldirish"

  return (
    <li className="flex items-center gap-s py-2xs">
      <Arrow
        size={20}
        aria-hidden={true}
        className="shrink-0"
        style={{ color: incoming ? "var(--color-success)" : "var(--color-text-secondary)" }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-step-0">{who}</span>
        <span className="flex items-center gap-2xs text-step--1 text-(--color-text-secondary)">
          <span>{formatWhen(item.createdAt)}</span>
          {/*
            The status is spelled out for anything that is not a plain success.
            A failed transfer that differs from a successful one only by the
            colour of its amount is a failed transfer nobody notices.
          */}
          {item.status === "COMPLETED" ? null : (
            <span style={{ color: `var(${status.token})` }}>· {status.text}</span>
          )}
        </span>
      </div>

      <span
        className="tabular shrink-0 text-step-0"
        style={{ color: incoming ? "var(--color-success)" : "var(--color-text)" }}
      >
        {/*
          The sign is text, not decoration: `direction` carries it on the wire
          precisely so a client cannot render an incoming payment as a debit by
          flipping one comparison.
        */}
        <span aria-hidden="true">{incoming ? "+ " : "− "}</span>
        <span className="sr-only">{incoming ? "kirim " : "chiqim "}</span>
        {formatMoney(BigInt(item.amount), "UZS")}
      </span>
    </li>
  )
}

export function RecentTransactions() {
  const query = useRecentTransfersQuery()
  const { data, freshness } = useCachedQuery("history:recent", historyResponseSchema, query)
  const items = data?.items ?? []

  return (
    <section
      aria-labelledby="recent-heading"
      aria-busy={freshness.kind === "loading"}
      className="flex flex-col gap-2xs"
    >
      <div className="flex items-baseline justify-between gap-2xs">
        <h2 id="recent-heading" className="m-0 text-step-1">
          So&apos;nggi amaliyotlar
        </h2>
        {items.length > 0 ? (
          <Link to="/history" className="text-step--1 text-(--color-primary)">
            Hammasi
          </Link>
        ) : null}
      </div>

      {freshness.kind === "loading" ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-s p-0">
            {SKELETON_KEYS.map((key) => (
              <li key={key}>
                <Skeleton width="100%" height="var(--text-step-2)" />
              </li>
            ))}
          </ul>
          <span className="sr-only">Amaliyotlar yuklanmoqda</span>
        </>
      ) : null}

      {freshness.kind === "absent" ? (
        <p
          role="status"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-warning)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          {/*
            Not an empty list. "No transactions" and "we could not load your
            transactions" look identical as a blank space and mean opposite
            things, and the wrong one of those two tells someone their transfer
            never happened.
          */}
          <span>Amaliyotlarni olishning imkoni bo&apos;lmadi.</span>
        </p>
      ) : null}

      {data && items.length === 0 ? (
        <p className="m-0 flex items-start gap-2xs text-step--1 text-(--color-text-secondary)">
          <Clock size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>
            Hali amaliyot yo&apos;q. Yuqoridagi demo to&apos;ldirish bilan boshlashingiz mumkin.
          </span>
        </p>
      ) : null}

      {items.length > 0 ? (
        <>
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
          <FreshnessLine freshness={freshness} label="Amaliyotlar" />
        </>
      ) : null}
    </section>
  )
}
