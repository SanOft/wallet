import { Eye, EyeOff } from "lucide-react"
import { useState } from "react"
import { hasSecret, type Session, wireText } from "./session.js"

/**
 * The request the simulator is posting, field by field.
 *
 * This panel is most of why the page is in "labs" rather than being a toy. Two
 * things about this channel are invisible from the handset and both are here:
 * `text` carries the entire conversation on every request (FR-9.2), and the
 * PIN travels inside it in clear.
 *
 * That second one is the evidence behind ADR-0010. GSM A5/1 is broken and NIST
 * SP 800-63B classifies the PSTN as RESTRICTED, which is an abstract claim
 * until you watch your own four digits appear in a form field.
 */

export function WirePanel(props: {
  readonly session: Session
  readonly phoneNumber: string
  readonly networkCode: string
  readonly serviceCode: string
}) {
  /*
   * Hidden by default, revealed on request.
   *
   * Both states are needed and neither is the whole truth. Printed by default,
   * the PIN would be in every screenshot and every recording made of this
   * screen — including the one FR-9.6 asks for in the README. Never printed,
   * the panel would be quietly editing the thing it exists to show.
   */
  const [revealed, setRevealed] = useState(false)
  const secret = hasSecret(props.session)

  return (
    <section className="flex flex-col gap-2xs">
      <h2 className="m-0 text-step-0">So&apos;rov tanasi</h2>

      <p className="m-0 text-step--1 text-(--color-text-secondary)">
        Har bir bosishda shu butun so&apos;rov qaytadan yuboriladi — server sessiyani saqlamaydi,
        suhbatni <code>text</code> maydonining o&apos;zi olib yuradi.
      </p>

      <dl
        className="m-0 gap-2xs rounded-(--radius-card) p-s text-step--1"
        style={{
          display: "grid",
          background: "var(--color-surface-sunken)",
          fontFamily: "var(--font-mono)",
          gridTemplateColumns: "auto 1fr",
        }}
      >
        <Row name="sessionId" value={props.session.id} />
        <Row name="phoneNumber" value={props.phoneNumber} />
        <Row name="networkCode" value={props.networkCode} />
        <Row name="serviceCode" value={props.serviceCode} />
        <Row name="text" value={wireText(props.session, revealed) || '""'} />
      </dl>

      {secret ? (
        <div className="flex flex-col items-start gap-3xs">
          <button
            type="button"
            aria-pressed={revealed}
            onClick={() => setRevealed((shown) => !shown)}
            className="flex items-center gap-2xs rounded-(--radius-control) border px-s text-step--1"
            style={{ minHeight: "var(--touch-target-min)", borderColor: "var(--color-neutral)" }}
          >
            {revealed ? (
              <EyeOff size={16} aria-hidden={true} />
            ) : (
              <Eye size={16} aria-hidden={true} />
            )}
            {revealed ? "PIN kodni yashirish" : "PIN kodni ko'rsatish"}
          </button>

          <p className="m-0 text-step--1" style={{ color: "var(--color-warning)" }}>
            Bu yerda yashirilgan — lekin haqiqiy tarmoqda PIN aynan shu maydonda, ochiq matn
            sifatida ketadi.
          </p>
        </div>
      ) : null}
    </section>
  )
}

function Row(props: { readonly name: string; readonly value: string }) {
  return (
    <>
      <dt className="text-(--color-text-secondary)">{props.name}</dt>
      {/* A session id is 36 characters with no spaces and would otherwise
          push the panel wider than a 320px screen. Inline for the reason
          given in Keypad.tsx. */}
      <dd className="m-0" style={{ overflowWrap: "anywhere" }}>
        {props.value}
      </dd>
    </>
  )
}
