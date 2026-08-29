# ADR-0010 — The PIN comes before any USSD disclosure, not only before a transfer

**Status:** Accepted — B6
**Relates to:** FR-9.5, NFR-1.11, §11.7, `apps/api/src/adapters/ussd/UssdAdapter.ts`

## Context

Two parts of the specification disagree about what the USSD PIN protects.

**§11.7's state machine** takes `MENU → BALANCE` straight to `END balance +
age`, and `MENU → HISTORY` straight to the last three transactions. The PIN
appears once, on the final step of a transfer. **FR-9.5** matches it: "a USSD
transfer requires a 4-digit PIN."

**NFR-1.11** says something wider: the channel as a whole is "gated by PIN +
low limits", and cites why — GSM A5/1 is weak (ITU/FIGI), and NIST SP 800-63B
classifies the PSTN as **RESTRICTED** for authentication.

The tension is not stylistic. On this channel there is no token, no session and
no password. The only claim of identity is the MSISDN the gateway reports, and
the two cited sources say precisely that this claim is not trustworthy. Under
§11.7 as drawn, anyone who can present a number — a lifted handset, a swapped
SIM, a gateway that can be told what to send — reads that person's balance and
their last three counterparties with no secret at any point.

## Decision

**Balance and history ask for the PIN first.** The transfer flow is left exactly
as §11.7 draws it.

```
""      -> CON menu
"1"     -> CON PIN            "1*PIN"  -> END balance
"3"     -> CON PIN            "3*PIN"  -> END last three
"2"     -> CON recipient -> CON amount -> CON PIN -> END result
```

Two smaller decisions follow from the same reasoning and are recorded here
because they look like omissions otherwise.

**The opening menu is answered without a database read.** It discloses nothing,
not even whether the dialling number belongs to an account. Refusing an unknown
caller at the menu would make the shortcode a membership oracle — the same
disclosure FR-1.5 refuses at registration.

**The recipient lookup keeps §11.7's position, before the PIN, and gains
FR-4.9's protection instead.** The caller must resolve to a registered account,
and their lookups are capped at twenty an hour — the web's numbers, applied to
the web's question. Moving that step behind the PIN was the alternative; it was
rejected because it makes a mistyped recipient cost a PIN entry inside a
180-second session that blocks after three, and the cap closes the same hole
without that.

## Consequences

**What it costs.** One extra step on the two read-only flows: four keypresses
before a balance that §11.7 showed immediately. On a channel where each round
trip is a real network turnaround, that is not free.

**A wrong PIN on a balance check counts toward the block.** Three of them
disable USSD transfers for an hour. That is the intended behaviour rather than
a side effect: it is one credential, so it gets one counter, exactly as a
failed step-up is counted against the login backoff in `TransferService`. The
opposite arrangement — a separate, uncounted budget for the read-only flows —
would be an unlimited oracle for guessing the same four digits.

**It creates no new denial of service.** An attacker who knows a number could
already burn its three attempts through the transfer flow that §11.7 specifies.

**Reversibility: easy.** The gate is two lines in `UssdAdapter.#dispatch` and
the `ask-pin` branch of `steps.ts`. Reverting to §11.7 as drawn is a small,
local change — and the tests that would then fail name the disclosure they were
protecting, so whoever does it will know what they are trading away.

## Rejected

**Follow §11.7 literally.** The specification is the contract and deviating from
a drawn diagram is not free. Rejected because NFR-1.11 is also the contract, it
is the security requirement of the two, and it carries primary-source citations
for why caller ID is not an authenticator. Where a security NFR and a
convenience diagram disagree, the NFR wins.

**Require the PIN for everything, including the opening menu.** Symmetrical, and
worse: the menu would have to refuse unknown callers to be meaningful, which
turns the shortcode into the membership oracle described above.
