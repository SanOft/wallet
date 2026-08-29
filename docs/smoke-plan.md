# Manual smoke plan

Everything built so far — B0–B6 and F0–F7 — exercised by hand against a local
API and the PWA on `localhost:5173`.

## What this is for, and what it is not for

594 automated tests already run on every push, and repeating them by hand is
worth nothing. This plan covers the three things they cannot:

1. **That the parts add up.** Each suite proves its own layer. Nobody has
   walked one person from registration through a USSD transfer and back to the
   web history in one sitting.
2. **What a screen actually looks like.** jsdom has no pixels, no focus ring
   and no service worker.
3. **Failure modes the suites can only simulate.** A real dropped connection, a
   real second tab, a real reload mid-flow.

**A step that fails is a defect, not a note.** Record what you saw, not what
you expected — the two differing is the entire point of doing this by hand.

---

## 0. Setup

| | |
|---|---|
| database | `docker compose up -d --wait` |
| migrations | `yarn workspace @wallet/api exec prisma migrate deploy` |
| demo accounts | `yarn workspace @wallet/api db:seed:demo` |
| API | `yarn workspace @wallet/api dev` → `:3000` |
| web | `yarn workspace @wallet/web dev` → `:5173` |

Accounts the seed creates, both with PIN `1234` and password
`orbit-walnut-lantern-quiet`:

| | |
|---|---|
| Sanjar Juraev | `+998884615500` |
| Amina Jurayeva | `+998884625500` |

Confirm before starting: `curl -s localhost:3000/health` answers, and
`localhost:5173` renders the login screen rather than a blank page.

> The dev server points at the `wallet` database and the suites at
> `wallet_test` (P-31). If `yarn test` ever empties the accounts below, that
> split has been undone and the smoke run is not what failed.

---

## 1. Registration and sign-in — FR-1, FR-2

| # | Do | Expect |
|---|---|---|
| 1.1 | Register a new number | Lands signed in, balance `0 so'm` |
| 1.2 | Register the **same** number again | A generic failure. **Not** "this number exists" — FR-1.5 exists so a stranger cannot walk a range and learn who banks here |
| 1.3 | Sign in with a wrong password four times | The fourth is slower or refused (FR-2.3 backoff). The message is identical to a wrong *number* — FR-2.2 |
| 1.4 | Sign in correctly, then reload | Still signed in, no flash of the login screen. The token lives in memory (FR-2.4); this is the refresh cookie working |
| 1.5 | Sign out, press Back | The login screen, not a cached home screen with somebody's balance on it |

## 2. Money — FR-10, FR-3, FR-4

| # | Do | Expect |
|---|---|---|
| 2.1 | As Sanjar, press **Demo to'ldirish** | +1 000 000, and a `Demo to'ldirish` row appears in history |
| 2.2 | Press it three more times in a day | The fourth is refused (FR-10.3) |
| 2.3 | Double-click the top-up button fast | **One** credit, not two (FR-4.4, idempotency) |
| 2.4 | Send 25 000 to `+998884625500` | The recipient's name shows as `AMINA J.` **before** the confirmation step (FR-4.6) |
| 2.5 | Change the number after the name appears | The name disappears. A name beside somebody else's number is how the wrong person gets paid |
| 2.6 | Try to send more than the balance | Refused before the request leaves the browser |
| 2.7 | Try to send to your own number | Refused |
| 2.8 | Complete the transfer | Both balances move. Sign in as Amina and confirm she received it |
| 2.9 | Look at the row above **Davom etish** on the amount step | **Bugungi qolgan chegara** shows a figure, not an em dash. An em dash means the accounts request has not answered — it must never render as the full limit (P-32) |
| 2.10 | Note the allowance, send 5 000, come back to the amount step | The allowance dropped by exactly 5 000. It is computed by the same function that would refuse the transfer, so a figure that disagrees with the refusal is the bug this row exists to catch |
| 2.11 | Type an amount larger than the remaining allowance | Refused in the browser with **Bugungi chegaradan oshdi**, and **Davom etish** is dead. The server still holds the real gate; this only saves the round trip |
| 2.12 | On step 1, look under the number field | **So'nggi qabul qiluvchilar** lists up to three people you have paid, each with a name **and** the number. Masked names are deliberately not unique (FR-4.6), so a list showing only names could pay the wrong person |
| 2.13 | Tap one of them | The number fills **and** the lookup runs — the name card appears with no typing. If **Davom etish** became live without a name card, FR-4.9's check was skipped, which is the one thing this shortcut must not do |
| 2.14 | Sign in as an account that has received money but never sent any (Amina, before she is used as a sender anywhere above) | The list is absent, not empty-with-a-heading. Incoming transfers withhold the sender's number (P-36), so a row from one could name somebody and then fill nothing |

## 3. History — FR-5

| # | Do | Expect |
|---|---|---|
| 3.1 | Open **Tarix** | Newest first, direction and amount legible at a glance |
| 3.2 | Filter, then reload the page | The filter survives — it is in the URL |
| 3.3 | Scroll to the end | More loads; nothing duplicates and nothing is skipped |
| 3.4 | Open one transaction | Its id is shown. FR-5.3 answers "I never sent this" |

## 4. The PWA — FR-8, F6

| # | Do | Expect |
|---|---|---|
| 4.1 | DevTools → Application → Service Workers | One registered and activated |
| 4.2 | Reload with the network **off** | The shell still renders. Not the browser's offline page |
| 4.3 | Offline, look at the balance | A number **with its age stated**. Never a bare figure presented as current — the whole point of F6.2 |
| 4.4 | Offline, queue a transfer | It appears as *queued*, worded so it cannot be read as sent |
| 4.5 | Reconnect | It drains, and the history row replaces the queued one |
| 4.6 | Offline, try the USSD lab | **Refused, with the reason.** A USSD session is 180 s the network holds open; queueing one is meaningless |

> DevTools network throttling does not flip `navigator.onLine`, so the offline
> banner will not appear under it. Use the offline checkbox.

## 5. The USSD channel — FR-9, B6, F7

Profile → **USSD simulyatori**.

| # | Dial | Expect |
|---|---|---|
| 5.1 | `*880#` | `Wallet / 1. Balans / 2. Pul o'tkazish / 3. Tarix` — and it must appear **without** the app knowing who you are yet |
| 5.2 | `1` | Asks for the PIN. Balance is **not** shown first (ADR-0010) |
| 5.3 | `1` → `9999` | `PIN noto'g'ri.` Three of these block USSD transfers for an hour |
| 5.4 | `2` → `884625500` | `AMINA J.` — masked, and transliterated if the name is Cyrillic |
| 5.5 | Watch the counter above the screen | `NN/182 septet`. This is the constraint the whole channel is shaped by |
| 5.6 | `2` → `884625500` → `25000` → `1234` | Sent, with the new balance. Check it against the web screen |
| 5.7 | Leave the session idle 3 minutes | It ends by itself, and says the **network** did it, not the server |
| 5.8 | Open the request panel | `text` accumulates: `""` → `"2"` → `"2*884625500"` … |
| 5.9 | Press **PIN kodni ko'rsatish** | The PIN is in that field. That is the evidence behind ADR-0010, not a UI flourish |

## 6. Accessibility — NFR-4

Not optional and not last because it matters least; last because it needs the
screens to exist first.

| # | Do | Expect |
|---|---|---|
| 6.1 | Tab through login, transfer and the lab | Focus always visible, order matches reading order |
| 6.2 | Complete a whole transfer with the keyboard only | Possible without a mouse |
| 6.3 | Turn on a screen reader for the USSD lab | The phone screen is announced when it changes |
| 6.4 | Zoom to 200% | Nothing is clipped, nothing scrolls sideways |
| 6.5 | Switch to dark mode mid-flow | No unreadable pair anywhere |

## 7. Nothing fails silently

The rule this project is held to, checked directly.

| # | Do | Expect |
|---|---|---|
| 7.1 | Stop the API, then use the app | Every screen says something. No spinner forever, no blank panel |
| 7.2 | With the API stopped, dial in the USSD lab | "Could not reach the gateway" — and **not** a fake `CON`/`END`, which would be a screen the server never sent |
| 7.3 | Keep the console open throughout | Every handled failure leaves a `[wallet]` line. A silent recovery is a defect |
| 7.4 | Restart the API, retry | Recovers without a reload |
| 7.5 | Find a transfer that failed, in **Tarix** | The amount is struck through, grey, and reads **bajarilmadi** — never a green `+`. Money that did not arrive must not look like money that did (#56) |
| 7.6 | On **Asosiy**, switch **Mavzu** between the three icons | System, light and dark each take effect. Reach them with Tab and the arrow keys: they are real radio inputs, so a keyboard user must be able to change the theme without a mouse |

## 8. The ledger still balances

After everything above:

```bash
yarn workspace @wallet/api db:reconcile
```

Expect `sum(ledger) = 0`, no drifts, and no chain breaks. Anything else means a
path above wrote money incorrectly, and it matters more than any screen in this
document.

---

## What this plan does not cover

- **No real USSD gateway.** Section 5 exercises our own simulator against the
  real adapter; the wire protocol is unverified against a third party.
- **One browser.** Everything here is Chrome unless you deliberately repeat it.
- **No deployed environment.** `localhost` has no CDN, no cold start and no
  proxy hop, so P-11 and P-27 cannot be observed here at all.
- **No load.** Every timing above is a single user on a warm local database.
- **Sections 6 and 7 are judgement, not pass/fail.** They are the two most
  likely to be waved through, which is why they are written as questions with
  observable answers rather than as checkboxes.
