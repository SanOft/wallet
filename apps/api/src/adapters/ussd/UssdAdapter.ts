import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import {
  CHANNEL_LIMITS,
  formatMoney,
  maskRecipientName,
  TRANSFER_LIMITS,
  USSD_MAX_SEPTETS,
  USSD_PIN_LENGTH,
  type UssdCallback,
} from "@wallet/shared"
import type { AuthService } from "../../domain/AuthService.js"
import { DomainError } from "../../domain/errors.js"
import type { HistoryRow, TransferService } from "../../domain/TransferService.js"
import { gsm7Septets, toGsm7 } from "./gsm7.js"
import { resolveStep } from "./steps.js"
import { SlidingWindow } from "./window.js"

/**
 * FR-9's channel adapter.
 *
 * §8.3's layer contract in its strictest form: everything below this file —
 * limits, ledger, idempotency, the PIN lock — is the same code the web calls,
 * and nothing below it knows this channel exists. What lives here is the two
 * things that are genuinely USSD's: turning one accumulated string into a step
 * (`steps.ts`), and turning a domain answer into 182 septets of GSM 7-bit text.
 *
 * **This adapter never throws.** A thrown error would reach the JSON error
 * handler and put `{"error":{"code":...}}` on a feature phone's screen, where
 * it means nothing and cannot be acted on. Every failure becomes an `END` with
 * a sentence, and the unexpected ones are reported through `warn` first — a
 * channel that swallows its own faults is worse than one that has none.
 */

export type UssdReply = {
  /** `CON` keeps the session open, `END` closes it (FR-9.3). */
  readonly kind: "CON" | "END"
  readonly text: string
}

/** Same seam as `TransferService`: the adapter reports, the route logs (§8.3). */
export type UssdWarning = (event: string, cause: unknown) => void

export interface UssdAdapterDependencies {
  readonly prisma: PrismaClient
  readonly auth: AuthService
  readonly transfers: TransferService
  readonly warn?: UssdWarning
  readonly now?: () => Date
}

/**
 * FR-4.9's budget, applied to the one step that answers "is this number
 * registered, and who is it".
 *
 * The web caps that question at twenty per user per hour. Over USSD the same
 * question is asked before any PIN, so without this it would be an open
 * enumeration oracle — strictly weaker than the endpoint it mirrors. The
 * numbers are FR-4.9's on purpose: one rule, two channels.
 */
const LOOKUP_LIMIT = 20
const LOOKUP_WINDOW_MS = 60 * 60 * 1000

/** Uzbekistan, where the subscribers are. A server has no locale of its own. */
const DISPLAY_TIME_ZONE = "Asia/Tashkent"

/**
 * How much of a name a row may spend.
 *
 * The budget is 182 septets and three history rows have to share it with their
 * dates and amounts. Truncating here rather than at the end is what keeps the
 * *last* row from being the one the network eats.
 */
const HISTORY_NAME_CHARS = 14
const RECIPIENT_NAME_CHARS = 30

const MESSAGES = {
  menu: "Wallet\n1. Balans\n2. Pul o'tkazish\n3. Tarix",
  askPin: "PIN kodni kiriting",
  askRecipient: "Qabul qiluvchi raqamini kiriting",
  askAmount: "Summa (so'm)",
  askConfirm: "Tasdiqlash uchun PIN kodni kiriting",
  unknownChoice: "Noto'g'ri tanlov.",
  notRegistered: "Bu raqam Wallet'da ro'yxatdan o'tmagan.",
  pinNotSet: "Avval ilovada PIN o'rnating.",
  pinWrong: "PIN noto'g'ri.",
  pinLocked: "PIN bloklandi. 1 soatdan keyin urinib ko'ring.",
  pinMalformed: `PIN ${USSD_PIN_LENGTH} ta raqamdan iborat.`,
  phoneInvalid: "Raqam noto'g'ri.",
  amountInvalid: "Summa noto'g'ri.",
  noHistory: "Hali amaliyot yo'q.",
  tooManyLookups: "Juda ko'p urinish. Keyinroq urinib ko'ring.",
  internal: "Xatolik yuz berdi. Keyinroq urinib ko'ring.",
} as const

/**
 * A domain refusal, said in one sentence a person can act on.
 *
 * `default` is deliberately a real message rather than the code: a code on a
 * feature phone is a dead end, and this list is exhaustive over what the calls
 * below can raise. An unlisted code means a new rule reached this channel
 * without anyone writing its sentence, which is what `warn` is for.
 */
function refusal(code: string): string {
  switch (code) {
    case "INSUFFICIENT_FUNDS":
      return "Balansda yetarli mablag' yo'q."
    case "LIMIT_EXCEEDED":
      return "Summa chegaradan oshadi."
    case "RECIPIENT_NOT_FOUND":
      return "Qabul qiluvchi topilmadi."
    case "SELF_TRANSFER_FORBIDDEN":
      return "O'zingizga pul yubora olmaysiz."
    case "PIN_NOT_SET":
      return MESSAGES.pinNotSet
    case "PIN_LOCKED":
      return MESSAGES.pinLocked
    case "AUTH_INVALID_CREDENTIALS":
      return MESSAGES.pinWrong
    case "RATE_LIMITED":
      return MESSAGES.tooManyLookups
    default:
      return MESSAGES.internal
  }
}

export class UssdAdapter {
  readonly #prisma: PrismaClient
  readonly #auth: AuthService
  readonly #transfers: TransferService
  readonly #warn: UssdWarning
  readonly #now: () => Date
  readonly #lookups = new SlidingWindow(LOOKUP_LIMIT, LOOKUP_WINDOW_MS)

  constructor({
    prisma,
    auth,
    transfers,
    warn = () => {},
    now = () => new Date(),
  }: UssdAdapterDependencies) {
    this.#prisma = prisma
    this.#auth = auth
    this.#transfers = transfers
    this.#warn = warn
    this.#now = now
  }

  /** Exposed so a test starts from a known budget rather than a shared one. */
  resetLookups(): void {
    this.#lookups.reset()
  }

  async handle(callback: UssdCallback): Promise<UssdReply> {
    try {
      return this.#fit(await this.#dispatch(callback))
    } catch (error) {
      // The adapter's own refusals already carry the sentence to show.
      if (error instanceof UssdEnd) return this.#fit({ kind: "END", text: error.message })

      if (error instanceof DomainError) {
        // A rule refused. Expected, and still worth a line: a channel whose
        // refusals are invisible is one where a broken limit looks like quiet
        // traffic.
        this.#warn("ussd.refused", error)
        return this.#fit({ kind: "END", text: refusal(error.code) })
      }

      // Never silent. This is the branch that would otherwise turn a bug into
      // a phone screen saying nothing and a log saying nothing either.
      this.#warn("ussd.failed", error)
      return this.#fit({ kind: "END", text: MESSAGES.internal })
    }
  }

  async #dispatch(callback: UssdCallback): Promise<UssdReply> {
    const step = resolveStep(callback.text)

    switch (step.kind) {
      case "menu":
        // Answered without a database read, so the opening screen discloses
        // nothing — not even whether this number is one of ours.
        return { kind: "CON", text: MESSAGES.menu }
      case "ask-pin":
        return { kind: "CON", text: MESSAGES.askPin }
      case "ask-recipient":
        return { kind: "CON", text: MESSAGES.askRecipient }
      case "balance":
        return this.#balance(callback, step)
      case "history":
        return this.#history(callback, step)
      case "quote-recipient":
        return this.#quoteRecipient(callback, step)
      case "quote-amount":
        return this.#quoteAmount(step)
      case "transfer":
        return this.#transfer(callback, step)
      case "unknown":
        return { kind: "END", text: MESSAGES.unknownChoice }
    }
  }

  /**
   * Who is dialling.
   *
   * Caller ID is the only identity this channel has, and NIST 800-63B puts the
   * PSTN in its RESTRICTED class for exactly that reason (NFR-1.11). So this
   * answers "which account" and never "may they see it" — every disclosure
   * below is gated by the PIN as well.
   */
  async #callerId(callback: UssdCallback): Promise<string> {
    const user = await this.#prisma.user.findFirst({
      where: { phone: callback.phoneNumber, accounts: { some: { type: "USER" } } },
      select: { id: true },
    })
    if (!user) throw new UssdEnd(MESSAGES.notRegistered)
    return user.id
  }

  /**
   * FR-9.5, and the gate ADR-0010 puts in front of every disclosure.
   *
   * A malformed PIN is refused before `verifyPin` sees it, so a mistyped
   * length never spends one of the three attempts that lead to an hour's
   * block. It is a typo, not a guess.
   */
  async #authorise(callback: UssdCallback, pin: string): Promise<string> {
    if (!new RegExp(`^\\d{${USSD_PIN_LENGTH}}$`).test(pin)) {
      throw new UssdEnd(MESSAGES.pinMalformed)
    }
    const userId = await this.#callerId(callback)
    await this.#auth.verifyPin(userId, pin)
    return userId
  }

  async #balance(callback: UssdCallback, step: { readonly pin: string }): Promise<UssdReply> {
    const userId = await this.#authorise(callback, step.pin)

    const account = await this.#prisma.account.findFirst({
      where: { userId, type: "USER" },
      select: { balance: true, currency: true },
    })
    if (!account) throw new UssdEnd(MESSAGES.notRegistered)

    /*
     * The time is part of the answer, not decoration.
     *
     * Everywhere else in this product a balance carries how old it is
     * (FR-3.4). Read straight from the row, this one is current as of now —
     * and saying when "now" was is what lets somebody reconcile two screens
     * that disagree, instead of guessing which is stale.
     */
    return {
      kind: "END",
      text: `Balans: ${formatMoney(account.balance, "UZS")}\n${this.#stamp(this.#now())}`,
    }
  }

  async #history(callback: UssdCallback, step: { readonly pin: string }): Promise<UssdReply> {
    const userId = await this.#authorise(callback, step.pin)

    const page = await this.#transfers.history({
      userId,
      cursor: null,
      from: null,
      to: null,
      direction: null,
      status: null,
      // §11.7: the last three. Not a page size chosen for the screen — three
      // rows and a header is what fits in 182 septets with room for a long
      // amount.
      limit: 3,
    })

    if (page.rows.length === 0) return { kind: "END", text: MESSAGES.noHistory }

    return {
      kind: "END",
      text: ["Oxirgi amaliyotlar:", ...page.rows.map((row) => this.#row(row))].join("\n"),
    }
  }

  #row(row: HistoryRow): string {
    const incoming = row.direction === "incoming"
    const name = truncate(row.counterparty?.maskedName ?? "Demo", HISTORY_NAME_CHARS)
    const sign = incoming ? "+" : "-"
    // The status only when it is not the expected one: a failed transfer that
    // reads like a completed one is the single worst row this screen can show.
    const flag = row.status === "COMPLETED" ? "" : " (x)"
    return `${this.#day(row.createdAt)} ${sign}${formatMoney(row.amount, "UZS")} ${name}${flag}`
  }

  async #quoteRecipient(
    callback: UssdCallback,
    step: { readonly phone: string },
  ): Promise<UssdReply> {
    /*
     * The caller has to be one of ours before this question is answered, and
     * their budget is FR-4.9's twenty an hour.
     *
     * Without both, this step is a better enumeration oracle than the endpoint
     * FR-4.9 was written for: no token, no cap, and a masked name on every
     * guess. §11.7 asks the recipient before the PIN and that order is kept —
     * what is added is the same protection the web already has.
     */
    const callerId = await this.#callerId(callback)
    if (!this.#lookups.admit(callerId, this.#now().getTime())) {
      throw new DomainError("RATE_LIMITED", "Too many USSD lookups")
    }

    const phone = normalisedNationalPhone(step.phone)
    if (!phone) throw new UssdEnd(MESSAGES.phoneInvalid)

    const recipient = await this.#prisma.user.findFirst({
      // Exact match on the full number, as on the web: no prefix search, so
      // the channel cannot be walked.
      where: { phone, accounts: { some: { type: "USER" } } },
      select: { firstName: true, lastName: true },
    })
    // The same answer for an unregistered number and for the treasury.
    if (!recipient) throw new UssdEnd(refusal("RECIPIENT_NOT_FOUND"))

    const name = truncate(
      maskRecipientName(recipient.firstName, recipient.lastName),
      RECIPIENT_NAME_CHARS,
    )
    return { kind: "CON", text: `${name}\n${MESSAGES.askAmount}` }
  }

  #quoteAmount(step: { readonly phone: string; readonly amount: string }): UssdReply {
    const amount = parseSom(step.amount)
    if (amount === null) throw new UssdEnd(MESSAGES.amountInvalid)

    /*
     * The channel's per-operation ceiling, checked here rather than left to
     * the service.
     *
     * The service is still the authority and still refuses — but it refuses
     * *after* the PIN, and over USSD that costs the user a PIN entry inside a
     * 180-second session for an amount they could have been told about a step
     * earlier. Same constant, so the two cannot drift; the daily, velocity and
     * new-recipient rules stay where they are, because they need the ledger.
     */
    if (amount > CHANNEL_LIMITS.USSD.perOperation) {
      throw new UssdEnd(
        `Chegara: ${formatMoney(CHANNEL_LIMITS.USSD.perOperation, "UZS")}dan oshmasin.`,
      )
    }

    return { kind: "CON", text: `${formatMoney(amount, "UZS")}\n${MESSAGES.askConfirm}` }
  }

  async #transfer(
    callback: UssdCallback,
    step: { readonly phone: string; readonly amount: string; readonly pin: string },
  ): Promise<UssdReply> {
    const phone = normalisedNationalPhone(step.phone)
    if (!phone) throw new UssdEnd(MESSAGES.phoneInvalid)

    const amount = parseSom(step.amount)
    if (amount === null) throw new UssdEnd(MESSAGES.amountInvalid)

    const senderUserId = await this.#authorise(callback, step.pin)

    const result = await this.#transfers.execute({
      senderUserId,
      recipientPhone: phone,
      amount,
      idempotencyKey: sessionKey(callback),
      channel: "USSD",
      /*
       * No `password`, and it is not an omission.
       *
       * FR-2.8's step-up asks for the account password, which is not something
       * anybody types on a numeric keypad — so a USSD transfer that needed one
       * could never complete. It cannot need one: `CHANNEL_LIMITS.USSD`
       * ceilings this channel below `STEP_UP_THRESHOLD`, and a test asserts
       * that relationship, because raising one constant without the other
       * would turn every large USSD transfer into a refusal nobody could act
       * on.
       */
    })

    if (result.status !== "COMPLETED") {
      // A stored failure replayed, or one the service recorded rather than
      // threw. Saying "sent" here is the one lie this screen must never tell.
      this.#warn("ussd.transfer_not_completed", result.failReason)
      return { kind: "END", text: refusal(result.failReason ?? "") }
    }

    return {
      kind: "END",
      text: `${formatMoney(result.amount, "UZS")} yuborildi.\nBalans: ${formatMoney(
        result.senderBalanceAfter,
        "UZS",
      )}`,
    }
  }

  /** `29.08 14:32`, in the subscribers' time zone rather than the server's. */
  #stamp(at: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: DISPLAY_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(at)
      .replace(/\//g, ".")
      .replace(",", "")
  }

  /** `29.08` — a history row has no room for the time. */
  #day(at: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: DISPLAY_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
    })
      .format(at)
      .replace(/\//g, ".")
  }

  /**
   * The last thing every reply passes through, including the error ones.
   *
   * Two guarantees, and they are guarantees rather than conventions because
   * the alternative is invisible: text the alphabet cannot carry silently
   * costs 112 of the 182 septets, and text over the budget is cut by the
   * network at whatever character it reaches. A message that still does not
   * fit after sanitising is a bug in the composition above — reported, then
   * cut here deliberately, so at least the front of the sentence survives.
   */
  #fit(reply: UssdReply): UssdReply {
    const text = toGsm7(reply.text)
    const septets = gsm7Septets(text)

    if (septets !== null && septets <= USSD_MAX_SEPTETS) return { ...reply, text }

    this.#warn("ussd.over_budget", { septets, length: text.length })
    return { ...reply, text: text.slice(0, USSD_MAX_SEPTETS) }
  }
}

/**
 * A message that ends the session, raised from wherever the reason is known.
 *
 * Not a `DomainError`: these are the adapter's own refusals — a mistyped PIN
 * length, a number that is not a number — and giving them domain codes would
 * put channel concerns into the catalogue every other channel shares.
 */
class UssdEnd extends Error {}

/**
 * `50000` (so'm) becomes `5000000` (tiyin).
 *
 * Two units meet here and nowhere else: subscribers type whole so'm on a
 * keypad, and §9.3 keeps every amount below this line in minor units. The
 * regex refuses a leading zero, so `0900` cannot be read as nine hundred.
 */
function parseSom(raw: string): bigint | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null

  const minor = BigInt(raw) * 100n
  const { min, max, step } = TRANSFER_LIMITS.UZS
  if (minor < min || minor > max || minor % step !== 0n) return null
  return minor
}

/**
 * `901234567`, `+998901234567` and `998901234567` are the same subscriber.
 *
 * A keypad has no `+`, so the national form is what people actually type — and
 * a channel that only accepted E.164 would reject the only spelling available
 * to it.
 */
function normalisedNationalPhone(raw: string): string | null {
  const digits = raw.replace(/^\+/, "")
  if (!/^\d{9,12}$/.test(digits)) return null

  const e164 = digits.length === 9 ? `+998${digits}` : `+${digits}`
  return /^\+998\d{9}$/.test(e164) ? e164 : null
}

/**
 * §11.7's idempotency key, over the whole accumulated text rather than the
 * step number.
 *
 * The spec says `hash(sessionId + step)`, and the step is a function of the
 * text, so this satisfies it — and binds the amount and the recipient as well.
 * That matters for the failure it prevents: a gateway redelivering the final
 * request produces the identical key and therefore one transfer, while a key
 * that named only the step would let two different final payloads share it and
 * make the second one a silent replay of the first.
 */
function sessionKey(callback: UssdCallback): string {
  return createHash("sha256")
    .update(`ussd:${callback.sessionId} ${callback.text}`)
    .digest("base64url")
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}
