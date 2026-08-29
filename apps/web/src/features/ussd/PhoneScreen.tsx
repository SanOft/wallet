import { gsm7Septets, USSD_MAX_SEPTETS } from "@wallet/shared"
import type { Reply } from "./session.js"

/**
 * What the handset shows, and nothing it does not.
 *
 * Monospace and pre-wrapped because a USSD message is laid out in character
 * cells: the adapter's menu is aligned with newlines, and rendering it in a
 * proportional font turns a numbered list into a paragraph. The budget the
 * message was fitted to is counted in those same cells.
 */

export function PhoneScreen(props: {
  readonly reply: Reply | undefined
  readonly dialling: boolean
  readonly serviceCode: string
}) {
  return (
    <div
      className="flex flex-col gap-2xs rounded-(--radius-card) p-s"
      style={{
        background: "var(--color-surface-sunken)",
        // Tall enough that a one-line reply and a five-line menu do not move
        // the input underneath. A control that jumps between turns is a
        // control the user has to re-find every time.
        minHeight: "12rem",
      }}
    >
      <p className="m-0 flex items-center justify-between gap-2xs text-step--1 text-(--color-text-secondary)">
        <span>{props.serviceCode}</span>
        <Budget reply={props.reply} />
      </p>

      {/*
        One live region for the screen, announced whole.
        `aria-atomic` because a USSD reply is a single message: announcing only
        the lines that changed would read out "2. Pul o'tkazish" on its own,
        which is not what the phone is showing.
      */}
      <div
        role="status"
        aria-atomic={true}
        aria-label="Telefon ekrani"
        className="flex-1 text-step-0"
        style={{
          fontFamily: "var(--font-mono)",
          // See Keypad.tsx: route-only utilities would ship in the login
          // screen's render-blocking stylesheet.
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        <ScreenBody reply={props.reply} dialling={props.dialling} />
      </div>
    </div>
  )
}

function ScreenBody(props: { readonly reply: Reply | undefined; readonly dialling: boolean }) {
  /*
   * The in-flight case comes first, and it replaces the previous screen rather
   * than sitting beside it.
   *
   * Leaving the last reply visible while the next is in flight would show a
   * menu that has already been answered as though it were the current one —
   * and on the confirmation step, a balance that the transfer being sent is
   * about to change.
   */
  if (props.dialling) return <span className="text-(--color-text-secondary)">…</span>

  if (!props.reply) {
    return <span className="text-(--color-text-secondary)">Terish uchun tugmani bosing.</span>
  }

  if (props.reply.kind === "malformed") {
    /*
     * Deliberately not rendered as a message. A body that is not `CON ` or
     * `END ` is not something the subscriber was told — it is a proxy page, a
     * stale deployment, or a bug — and printing it inside the phone frame
     * would be this page's one unforgivable lie.
     */
    return (
      <span className="text-(--color-danger)">
        Javob USSD formatida emas. Bu xabar foydalanuvchiga ko&apos;rsatilmagan bo&apos;lardi.
      </span>
    )
  }

  return <span>{props.reply.text}</span>
}

/**
 * The invisible constraint, made visible.
 *
 * 182 septets is the whole reason `toGsm7` exists, and it is the one property
 * of this channel a reader cannot otherwise observe: an over-long reply is not
 * rejected anywhere they can see, it is cut by the network. Measured with the
 * function the adapter fits its replies with — a second implementation here
 * would put a confident wrong number on the only screen built to show the
 * right one.
 */
function Budget(props: { readonly reply: Reply | undefined }) {
  if (!props.reply || props.reply.kind === "malformed") return null

  const septets = gsm7Septets(props.reply.text)

  if (septets === null) {
    return (
      <span className="text-(--color-danger)">GSM-7 emas — tarmoq 70 belgidan keyin kesadi</span>
    )
  }

  const over = septets > USSD_MAX_SEPTETS

  return (
    <span
      className="tabular"
      style={{ color: over ? "var(--color-danger)" : "var(--color-text-secondary)" }}
    >
      {septets}/{USSD_MAX_SEPTETS} septet
    </span>
  )
}
