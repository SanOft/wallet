import { formatMoney } from "@wallet/shared"
import { TriangleAlert } from "lucide-react"
import { FreshnessLine } from "../../components/Freshness.js"
import { Skeleton } from "../../components/Skeleton.js"
import { knownCurrency } from "../../lib/currency.js"
import { freshnessOf, useOnline } from "../../lib/freshness.js"
import { useAccountsQuery } from "./api.js"

/**
 * FR-3, and the one rule this screen exists to hold: the balance is never
 * shown without saying when it was true.
 *
 * The failure mode being designed against is not a wrong number — the ledger
 * makes that hard — but a *right number shown too late*. A tab left open on a
 * dead network keeps rendering the last balance in the present tense, and
 * nothing about it looks wrong. So the card has three states and none of them
 * is "a figure on its own": loading shows a placeholder, a failure with no
 * cached value shows a refusal, and a figure always carries its age.
 *
 * What it must never do is render `0`. A zero balance and an unknown balance
 * are the same shape on screen and opposite facts, and the account whose
 * request failed is the one where a confident zero would cause someone to
 * top up money they already have.
 */
export function BalanceCard() {
  const query = useAccountsQuery()
  const online = useOnline()
  const freshness = freshnessOf(query, online)

  // MVP is one UZS account (FR-3.1), but the response is a list because §21's
  // Q-3 keeps a second currency non-breaking — so this picks rather than
  // assumes `[0]`.
  const found = query.data?.accounts.find((candidate) => candidate.type === "USER")

  /*
   * An account whose currency this build cannot format is treated as no
   * account at all, and the card says so rather than rendering a number with
   * the wrong symbol. It cannot happen today — the server only ever creates
   * UZS — but "cannot happen" is what the cast would have been asserting.
   */
  const currency = found ? knownCurrency(found.currency) : null
  const account = found && currency ? { balance: found.balance, currency } : null

  return (
    <section
      aria-labelledby="balance-heading"
      aria-busy={freshness.kind === "loading"}
      className="flex flex-col gap-2xs rounded-(--radius-card) p-m"
      style={{ background: "var(--color-surface-sunken)" }}
    >
      <h2 id="balance-heading" className="m-0 text-step--1 text-(--color-text-secondary)">
        Hisobingiz
      </h2>

      {freshness.kind === "loading" ? (
        <>
          <Skeleton width="60%" height="var(--text-step-4)" />
          <span className="sr-only">Balans yuklanmoqda</span>
        </>
      ) : null}

      {freshness.kind === "absent" || (freshness.kind !== "loading" && !account) ? (
        <p
          role="alert"
          className="m-0 flex items-start gap-2xs text-step-0"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={18} aria-hidden={true} className="mt-3xs shrink-0" />
          {/*
            Not "0 so'm". An unknown balance and an empty one are the same
            shape and opposite facts, and guessing the wrong one here is how
            somebody tops up money they already have.
          */}
          <span>Balansni olishning imkoni bo&apos;lmadi. Internetni tekshirib, yangilang.</span>
        </p>
      ) : null}

      {account ? (
        <>
          <p className="tabular m-0 text-step-4">
            {formatMoney(BigInt(account.balance), account.currency)}
          </p>
          <FreshnessLine freshness={freshness} label="Balans" />
        </>
      ) : null}
    </section>
  )
}
