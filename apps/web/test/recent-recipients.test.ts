import type { HistoryItem } from "@wallet/shared"
import { describe, expect, it } from "vitest"
import { __pickRecipients as pickRecipients } from "../src/features/transfer/RecentRecipients.js"

/**
 * §13.5 step 1's quick pick, as a rule rather than through a rendered list.
 *
 * The list is derived from the history the screen already holds, so what is
 * worth testing is the derivation: which rows become entries, in what order,
 * and — the one that costs money if it is wrong — that an entry always carries
 * the number it claims to fill in.
 */

function row(over: Partial<HistoryItem>): HistoryItem {
  return {
    id: crypto.randomUUID(),
    createdAt: "2026-08-29T10:00:00.000Z",
    status: "COMPLETED",
    type: "P2P",
    channel: "WEB",
    direction: "outgoing",
    amount: "100000",
    counterparty: { maskedName: "ZULFIYA K.", phone: "+998901111111" },
    ...over,
  }
}

describe("who the quick pick offers", () => {
  it("offers people the user sent to", () => {
    const picked = pickRecipients([row({})])

    expect(picked).toEqual([{ phone: "+998901111111", name: "ZULFIYA K." }])
  })

  it("never offers a row it cannot fill the field from", () => {
    /*
     * An incoming transfer withholds the sender's number (P-36), so a row built
     * from one would show a name and then fill nothing — a shortcut that leaves
     * the user worse off than typing. A top-up has no counterparty at all.
     */
    const picked = pickRecipients([
      row({ direction: "incoming", counterparty: { maskedName: "ALISHER N.", phone: null } }),
      row({ type: "TOPUP", counterparty: null }),
    ])

    expect(picked).toEqual([])
  })

  it("does not offer the sender of an incoming transfer, even carrying a number", () => {
    /*
     * Not a shape the server produces — P-36 withholds the sender's number —
     * which is exactly why the direction check has to be tested against a row
     * the masking failed on. "Recent recipients" means people paid, and
     * offering somebody because they paid *you* puts a stranger one tap from
     * the amount field.
     */
    const picked = pickRecipients([
      row({
        direction: "incoming",
        counterparty: { maskedName: "ALISHER N.", phone: "+998903333333" },
      }),
    ])

    expect(picked).toEqual([])
  })

  it("keeps the most recent of a repeated recipient, once", () => {
    // Paying the same person four times should not fill the list with them.
    const same = { maskedName: "ZULFIYA K.", phone: "+998901111111" }
    const picked = pickRecipients([row({ counterparty: same }), row({ counterparty: same })])

    expect(picked).toHaveLength(1)
  })

  it("keeps history order, so the last person paid is first", () => {
    const picked = pickRecipients([
      row({ counterparty: { maskedName: "B", phone: "+998902222222" } }),
      row({ counterparty: { maskedName: "A", phone: "+998901111111" } }),
    ])

    expect(picked.map((p) => p.name)).toEqual(["B", "A"])
  })

  it("offers somebody whose payment failed", () => {
    /*
     * Deliberate. A refused transfer makes a person *more* likely to be trying
     * again, and the list says who they meant to pay rather than what happened
     * — the row in the history is where the outcome belongs.
     */
    const picked = pickRecipients([row({ status: "FAILED" })])

    expect(picked).toHaveLength(1)
  })

  it("shows at most three, so the number field stays on screen", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      row({ counterparty: { maskedName: `P${i}`, phone: `+99890000000${i}` } }),
    )

    expect(pickRecipients(many)).toHaveLength(3)
  })
})
