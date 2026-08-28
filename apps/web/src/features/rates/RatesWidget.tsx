import type { Rate } from "@wallet/shared"
import { TrendingDown, TrendingUp } from "lucide-react"
import { useEffect } from "react"
import { Skeleton } from "../../components/Skeleton.js"
import { reportError } from "../../lib/report.js"
import { useRatesQuery } from "./api.js"

/**
 * FR-7, and the smallest thing on the screen.
 *
 * Informational only (FR-7.3), which decides how it fails: when the rates
 * cannot be had, the widget disappears. It does not show an error, because an
 * error implies something is broken that the user should act on, and a wallet
 * with no exchange-rate widget is a wallet — every other thing on this screen
 * still works. The one thing it must not do is show a number without saying
 * how old it is, which is the same rule the balance follows.
 */

/** `Diff` arrives as a signed decimal string; only its sign is used here. */
function direction(diff: string): "up" | "down" | "flat" {
  const value = Number(diff)
  if (!Number.isFinite(value) || value === 0) return "flat"
  return value > 0 ? "up" : "down"
}

function RateRow(props: { readonly rate: Rate }) {
  const { rate } = props
  const trend = direction(rate.diff)
  const Icon = trend === "up" ? TrendingUp : TrendingDown

  return (
    <li className="flex items-baseline justify-between gap-2xs">
      <span className="text-step--1 text-(--color-text-secondary)">
        1 {rate.currency}
        {/* The nominal is almost always 1 and saying so would be noise; when it
            is not, leaving it out would make the number wrong. */}
        {rate.nominal === "1" ? null : ` (×${rate.nominal})`}
      </span>
      <span className="flex items-baseline gap-2xs">
        <span className="tabular text-step-0">{rate.rate}</span>
        {trend === "flat" ? null : (
          <span
            className="flex items-center gap-3xs text-step--1"
            style={{ color: trend === "up" ? "var(--color-success)" : "var(--color-danger)" }}
          >
            <Icon size={14} aria-hidden={true} />
            {/*
              Colour is never the only carrier: the sign is in the text, and
              the words below the icon say which way for a screen reader. §13.2.2
              pairs every semantic colour with something readable.
            */}
            <span className="sr-only">{trend === "up" ? "o'sdi" : "tushdi"} </span>
            <span className="tabular">{rate.diff}</span>
          </span>
        )}
      </span>
    </li>
  )
}

export function RatesWidget() {
  const { data, isLoading, isError, error } = useRatesQuery()

  /*
   * Reported even though the user is told nothing.
   *
   * Hiding the widget is right for them — FR-7.3 makes these numbers
   * decoration, and decoration that shouts is worse than decoration that is
   * absent. But a widget that disappears silently is a widget that can be
   * broken for a month before anyone notices, and "the rates stopped working
   * at some point" is not a bug report anyone can act on.
   */
  useEffect(() => {
    if (isError) reportError("rates:hidden", error)
  }, [isError, error])

  if (isError) return null

  return (
    <section aria-labelledby="rates-heading" className="flex flex-col gap-2xs">
      <h2 id="rates-heading" className="m-0 text-step-1">
        Valyuta kurslari
      </h2>

      {isLoading ? (
        <>
          <Skeleton width="100%" height="var(--text-step-1)" />
          <span className="sr-only">Kurslar yuklanmoqda</span>
        </>
      ) : null}

      {data ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-3xs p-0">
            {data.rates.map((rate) => (
              <RateRow key={rate.currency} rate={rate} />
            ))}
          </ul>
          <p className="m-0 text-step--1 text-(--color-text-secondary)">
            {/*
              The server says whether what it sent is current or the last it
              could get (FR-7.2), and this renders that answer rather than
              deciding for itself — two clients judging freshness from a
              timestamp would eventually disagree with the server and with
              each other about the same numbers.
            */}
            {data.stale
              ? `Markaziy bank bilan aloqa yo'q — ${data.rates[0]?.publishedOn ?? ""} holatiga ko'ra`
              : `Markaziy bank, ${data.rates[0]?.publishedOn ?? ""}`}
          </p>
        </>
      ) : null}
    </section>
  )
}
