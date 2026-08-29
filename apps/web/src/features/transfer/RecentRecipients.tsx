import type { HistoryItem } from "@wallet/shared"
import { UserRound } from "lucide-react"
import { useRecentTransfersQuery } from "../history/api.js"

/**
 * §13.5 step 1: "a recent-recipients list (quick pick)".
 *
 * Typing a nine-digit number to pay the same person again is the friction this
 * removes, and on the connection NFR-3 is written for it also removes a lookup
 * — FR-4.9 allows twenty an hour, and paying somebody you paid yesterday
 * should not spend one.
 *
 * Built from the history the screen already has rather than a new endpoint.
 * There is no "saved contacts" table and this deliberately does not invent one:
 * a list derived from transfers cannot drift from them, and nothing has to be
 * deleted when a person is forgotten.
 */

/** Enough to be useful, few enough not to push the number field off a phone. */
const MAX = 3

/**
 * Distinct recipients, most recently paid first.
 *
 * Outgoing only — these are people the user *sent to*, which is what "recent
 * recipients" means and also the only rows carrying a number (P-36): on an
 * incoming transfer the sender's phone is withheld, so a row from it could
 * name somebody and then fail to fill the field.
 *
 * Failed transfers still count. Somebody whose payment was refused is
 * *more* likely to be trying again, and the list says who they meant to pay,
 * not what happened.
 */
function pickRecipients(items: readonly HistoryItem[]): { phone: string; name: string }[] {
  const seen = new Map<string, string>()

  for (const item of items) {
    const phone = item.direction === "outgoing" ? item.counterparty?.phone : null
    if (!phone || seen.has(phone)) continue
    seen.set(phone, item.counterparty?.maskedName ?? phone)
    if (seen.size === MAX) break
  }

  return [...seen].map(([phone, name]) => ({ phone, name }))
}

export function RecentRecipients(props: { readonly onPick: (phone: string) => void }) {
  const query = useRecentTransfersQuery()
  const recipients = pickRecipients(query.data?.items ?? [])

  // Nothing to show on a first transfer, and an empty heading over an empty
  // list is worse than no heading.
  if (recipients.length === 0) return null

  return (
    <section aria-labelledby="recent-recipients" className="flex flex-col gap-2xs">
      <h2 id="recent-recipients" className="m-0 text-step--1 text-(--color-text-secondary)">
        So&apos;nggi qabul qiluvchilar
      </h2>

      <ul className="m-0 flex list-none flex-col gap-3xs p-0">
        {recipients.map((recipient) => (
          <li key={recipient.phone}>
            <button
              type="button"
              onClick={() => props.onPick(recipient.phone)}
              className="flex w-full items-center gap-2xs rounded-(--radius-control) px-2xs text-start"
              style={{
                minHeight: "var(--touch-target-min)",
                background: "var(--color-surface-sunken)",
                color: "var(--color-text)",
              }}
            >
              <UserRound size={18} aria-hidden={true} className="shrink-0" />
              <span className="truncate">{recipient.name}</span>
              {/*
                The number as well as the name. A masked name is deliberately
                not unique — FR-4.6 makes sure of it — so two people can appear
                as the same label, and picking the wrong one sends money to the
                wrong person.
              */}
              <span className="tabular ms-auto shrink-0 text-step--1 text-(--color-text-secondary)">
                {recipient.phone}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Exported for its own test: the rule is worth checking without a DOM. */
export const __pickRecipients = pickRecipients
