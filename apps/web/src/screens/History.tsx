import { formatMoney, type HistoryItem } from "@wallet/shared"
import { ArrowDownLeft, ArrowUpRight, Filter, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Link, useSearchParams } from "react-router"
import { Skeleton } from "../components/Skeleton.js"
import { type HistoryFilters, useTransferPageQuery } from "../features/history/api.js"
import { amountTone } from "../lib/amountTone.js"
import { formatWhen } from "../lib/datetime.js"

/**
 * FR-5's history: filtered, paged, and readable from a link.
 *
 * The filters live in the URL (§13.5 asks for it) and that is worth more than
 * a preference: a filtered list is a claim about somebody's money, and a claim
 * you cannot send to support or return to after a reload is one they have to
 * reconstruct from memory. It also makes the back button mean what it looks
 * like it means.
 *
 * Pages accumulate rather than replace. Cursor pagination is what makes that
 * safe: a new transfer arriving while somebody scrolls cannot shift the page
 * boundary, because the cursor names a position rather than a count (§12.2).
 */

const DIRECTIONS = [
  { value: "", label: "Hammasi" },
  { value: "outgoing", label: "Chiqim" },
  { value: "incoming", label: "Kirim" },
] as const

const STATUSES = [
  { value: "", label: "Har qanday" },
  { value: "COMPLETED", label: "Bajarilgan" },
  { value: "PENDING", label: "Kutilmoqda" },
  { value: "FAILED", label: "Bajarilmagan" },
] as const

const STATUS_LABEL: Record<HistoryItem["status"], { text: string; token: string }> = {
  COMPLETED: { text: "Bajarildi", token: "--color-success" },
  PENDING: { text: "Kutilmoqda", token: "--color-warning" },
  FAILED: { text: "Bajarilmadi", token: "--color-danger" },
}

function Row(props: { readonly item: HistoryItem }) {
  const { item } = props
  const incoming = item.direction === "incoming"
  const Arrow = incoming ? ArrowDownLeft : ArrowUpRight
  const tone = amountTone(item.direction, item.status)

  return (
    <li>
      <Link
        to={`/history/${item.id}`}
        className="flex items-center gap-s py-2xs no-underline"
        style={{ color: "inherit" }}
      >
        <Arrow size={20} aria-hidden={true} className="shrink-0" style={{ color: tone.colour }} />

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-step-0">
            {item.counterparty?.maskedName ?? "Demo to'ldirish"}
          </span>
          <span className="flex items-center gap-2xs text-step--1 text-(--color-text-secondary)">
            <span>{formatWhen(item.createdAt)}</span>
            {item.status === "COMPLETED" ? null : (
              <span style={{ color: `var(${STATUS_LABEL[item.status].token})` }}>
                · {STATUS_LABEL[item.status].text}
              </span>
            )}
          </span>
        </div>

        <span
          className="tabular shrink-0 text-step-0"
          style={{
            color: tone.colour,
            textDecoration: tone.struck ? "line-through" : undefined,
          }}
        >
          <span aria-hidden="true">{tone.sign}</span>
          <span className="sr-only">{tone.label}</span>
          {formatMoney(BigInt(item.amount), "UZS")}
        </span>
      </Link>
    </li>
  )
}

export function History() {
  const [params, setParams] = useSearchParams()

  /*
   * The URL is the filter state, not a copy of it. Holding both would give two
   * answers to "what is being shown" — and the one that loses is always the
   * URL, which is the one somebody pasted into a support conversation.
   */
  const filters: HistoryFilters = {
    ...(params.get("direction") === "incoming" || params.get("direction") === "outgoing"
      ? { direction: params.get("direction") as "incoming" | "outgoing" }
      : {}),
    ...(params.get("status") ? { status: params.get("status") as HistoryItem["status"] } : {}),
    ...(params.get("from") ? { from: `${params.get("from")}T00:00:00.000Z` } : {}),
    ...(params.get("to") ? { to: `${params.get("to")}T23:59:59.999Z` } : {}),
  }

  const key = params.toString()

  /*
   * The cursor is stored *with* the filters it belongs to, and read back only
   * when they still match. Derived during render rather than cleared in an
   * effect, because an effect runs after the render that used the stale value
   * — so changing a filter fired one request continuing a list the server had
   * never been asked for, and only then corrected itself. A wasted round trip
   * on the connection NFR-3 assumes is bad, and a page of the wrong list on
   * screen for as long as it took.
   */
  const [paging, setPaging] = useState<{ key: string; cursor?: string }>({ key })
  const cursor = paging.key === key ? paging.cursor : undefined

  const query = useTransferPageQuery({ ...filters, ...(cursor ? { cursor } : {}) })

  const items = query.data?.items ?? []
  const nextCursor = query.data?.nextCursor ?? null

  function update(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col gap-l">
      <h1 className="m-0 text-step-3">Tarix</h1>

      <section aria-labelledby="filters-heading" className="flex flex-col gap-2xs">
        <h2 id="filters-heading" className="m-0 flex items-center gap-2xs text-step-1">
          <Filter size={18} aria-hidden={true} />
          Saralash
        </h2>

        <div className="flex flex-wrap gap-2xs">
          <label className="flex flex-col gap-3xs text-step--1 text-(--color-text-secondary)">
            Yo&apos;nalish
            <select
              value={params.get("direction") ?? ""}
              onChange={(event) => update("direction", event.target.value)}
              className="rounded-(--radius-control) px-2xs"
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {DIRECTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-3xs text-step--1 text-(--color-text-secondary)">
            Holat
            <select
              value={params.get("status") ?? ""}
              onChange={(event) => update("status", event.target.value)}
              className="rounded-(--radius-control) px-2xs"
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-3xs text-step--1 text-(--color-text-secondary)">
            Boshlanish
            <input
              type="date"
              value={params.get("from") ?? ""}
              onChange={(event) => update("from", event.target.value)}
              className="rounded-(--radius-control) px-2xs"
              style={{ minHeight: "var(--touch-target-min)" }}
            />
          </label>

          <label className="flex flex-col gap-3xs text-step--1 text-(--color-text-secondary)">
            Tugash
            <input
              type="date"
              value={params.get("to") ?? ""}
              onChange={(event) => update("to", event.target.value)}
              className="rounded-(--radius-control) px-2xs"
              style={{ minHeight: "var(--touch-target-min)" }}
            />
          </label>
        </div>
      </section>

      <section aria-labelledby="list-heading" aria-busy={query.isLoading}>
        <h2 id="list-heading" className="sr-only">
          Amaliyotlar
        </h2>

        {query.isLoading ? (
          <ul className="m-0 flex list-none flex-col gap-s p-0">
            {["a", "b", "c"].map((row) => (
              <li key={row}>
                <Skeleton width="100%" height="var(--text-step-2)" />
              </li>
            ))}
          </ul>
        ) : null}

        {query.isError ? (
          <p
            role="alert"
            className="m-0 flex items-start gap-2xs text-step--1"
            style={{ color: "var(--color-danger)" }}
          >
            <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
            {/*
              Not an empty list. "Nothing matches" and "we could not load it"
              are the same blank space and opposite facts, and the wrong one
              tells somebody a transfer never happened.
            */}
            <span>Amaliyotlarni olishning imkoni bo&apos;lmadi.</span>
          </p>
        ) : null}

        {query.data && items.length === 0 ? (
          <p className="m-0 text-step--1 text-(--color-text-secondary)">
            {/*
              The filter-empty state F5's definition of done asks for by name.
              Saying which filters are in force is what stops somebody
              concluding their history is gone.
            */}
            {key
              ? "Bu saralash bo'yicha amaliyot topilmadi. Saralashni o'zgartirib ko'ring."
              : "Hali amaliyot yo'q."}
          </p>
        ) : null}

        {items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        ) : null}
      </section>

      {nextCursor ? (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => setPaging({ key, cursor: nextCursor })}
          className="rounded-(--radius-control) px-s"
          style={{
            minHeight: "var(--touch-target-min)",
            background: "var(--color-surface-sunken)",
            color: "var(--color-text)",
          }}
        >
          {/*
            A button rather than a scroll observer. §13.5 says "infinite
            scroll", and a list that loads on scroll is a list somebody on a
            metered connection cannot stop — on the screen where they are most
            likely to be scrolling idly. The button costs one tap and makes the
            next page a decision.
          */}
          {query.isFetching ? "Yuklanmoqda…" : "Yana yuklash"}
        </button>
      ) : null}
    </div>
  )
}
