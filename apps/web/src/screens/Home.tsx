import { ThemeToggle } from "../app/ThemeToggle.js"
import { ErrorBoundary } from "../components/ErrorBoundary.js"
import { BalanceCard } from "../features/accounts/BalanceCard.js"
import { TopUpButton } from "../features/accounts/TopUpButton.js"
import { RecentTransactions } from "../features/history/RecentTransactions.js"
import { QueuedList } from "../features/outbox/QueuedList.js"
import { RatesWidget } from "../features/rates/RatesWidget.js"

/**
 * F3's home screen (§13.3): balance, what you can do with it, the last few
 * movements, and the rates.
 *
 * Ordered by what someone opens the app to find out. The balance is first
 * because it is the question; the history is below the fold on a small phone
 * and that is correct — it is what you scroll to when the number surprised
 * you. Sending joins the top group at F4, which is the other half of the
 * answer.
 *
 * F0's design-system showcase used to live here and now sits at `/design`,
 * where its width-and-theme check still works without standing between the
 * user and their money.
 */
export function Home() {
  return (
    <div className="flex flex-col gap-l">
      <header className="flex items-start justify-between gap-s">
        <h1 className="m-0 text-step-3">Wallet</h1>
        <ThemeToggle />
      </header>

      {/*
        One boundary per section, not one for the page. A single boundary at
        the root turns any fault into "the whole app is down", which is both
        less true and less useful than "the rates failed, your balance is
        right there".
      */}
      <ErrorBoundary scope="balance" title="Balansni ko'rsatib bo'lmadi.">
        <BalanceCard />
      </ErrorBoundary>

      {/*
        §13.3 puts a "Send money" call to action here, and it is deliberately
        absent until F4 builds the route behind it. A primary button on the
        first screen after sign-in that answers with "page not found" is worse
        than a screen with one action: it teaches people that this app's
        buttons cannot be trusted, on the screen where trust is being
        established.
      */}
      <ErrorBoundary scope="topup" title="To'ldirish tugmasini ko'rsatib bo'lmadi.">
        <TopUpButton />
      </ErrorBoundary>

      {/*
        Above the history, because a queued item is not a transaction: nothing
        has moved and no ledger entry exists. Below the actions, because it is
        a consequence of them.
      */}
      <ErrorBoundary scope="outbox" title="Navbatni ko'rsatib bo'lmadi.">
        <QueuedList />
      </ErrorBoundary>

      <ErrorBoundary scope="history" title="Amaliyotlarni ko'rsatib bo'lmadi.">
        <RecentTransactions />
      </ErrorBoundary>

      <ErrorBoundary scope="rates" title="Kurslarni ko'rsatib bo'lmadi.">
        <RatesWidget />
      </ErrorBoundary>
    </div>
  )
}
