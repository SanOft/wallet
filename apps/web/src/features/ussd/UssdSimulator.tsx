import { PhoneCall, PhoneOff, RotateCcw, TriangleAlert } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { FormField } from "../../components/FormField.js"
import { Input } from "../../components/Input.js"
import { useOnline } from "../../lib/freshness.js"
import { reportError } from "../../lib/report.js"
import { useAccountsQuery } from "../accounts/api.js"
import { useDialMutation } from "./api.js"
import { Keypad } from "./Keypad.js"
import { PhoneScreen } from "./PhoneScreen.js"
import {
  accumulate,
  asksForPin,
  currentReply,
  type Exchange,
  isExpired,
  newSession,
  remainingMs,
  type Session,
} from "./session.js"
import { WirePanel } from "./WirePanel.js"

/**
 * F7 (FR-9.6): the handset, the gateway, and the wire between them.
 *
 * Everything the adapter decides — what the menu says, what a wrong PIN costs,
 * whether a transfer is inside the channel limit — happens on the server and
 * is not repeated here. This component knows three things a gateway knows:
 * how to accumulate `text`, how to read a `CON`/`END` prefix, and when the
 * network gives up on an idle session.
 */

/**
 * A real Uzbek MNC and the shortcode §11.7 dials. Constants rather than fields:
 * the adapter parses both and then ignores them on purpose, and a form that
 * invited them to be edited would suggest they change something.
 */
const NETWORK_CODE = "62120"
const SERVICE_CODE = "*880#"

/** A USSD entry accepts digits and the two symbols on a keypad. Nothing else. */
const ALLOWED_INPUT = /^[0-9*#]*$/

export function UssdSimulator() {
  const online = useOnline()
  const accounts = useAccountsQuery()
  const [dial, { isLoading }] = useDialMutation()

  const [session, setSession] = useState<Session | null>(null)
  const [input, setInput] = useState("")
  const [now, setNow] = useState(() => Date.now())
  /** What to send again after a transport failure. See `retry`. */
  const retryable = useRef<{ readonly input: string; readonly secret: boolean } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  /*
   * The clock only runs while a session is open.
   *
   * A second-by-second interval on a page nobody is dialling would keep the
   * tab awake to count down something that is not counting.
   */
  const counting = session?.status === "open"
  useEffect(() => {
    if (!counting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [counting])

  /*
   * Expiry is derived, not stored.
   *
   * The alternative — an effect that writes `status: "expired"` when the timer
   * passes 180s — has two states that can disagree, and the one that decides
   * whether the input is disabled would be the one updated a tick late.
   */
  const expired = session ? isExpired(session, now) : false
  const status = expired ? "expired" : session?.status
  const live = status === "open"

  const send = useCallback(
    async (session: Session, typed: string, secret: boolean) => {
      const text = accumulate(session.text, typed)
      retryable.current = { input: typed, secret }

      try {
        const reply = await dial({
          sessionId: session.id,
          phoneNumber: accounts.data?.user.phone ?? "",
          networkCode: NETWORK_CODE,
          serviceCode: SERVICE_CODE,
          text,
        }).unwrap()

        if (reply.kind === "malformed") {
          /*
           * Not shown as a message, and reported rather than swallowed. The
           * screen says the body was not a USSD reply; this line is what tells
           * whoever has to explain it *what* arrived instead.
           */
          reportError("ussd:malformed", new Error("not a CON/END body"), {
            body: reply.body.slice(0, 200),
          })
        }

        const exchange: Exchange = { input: typed, secret, reply }
        retryable.current = null

        /*
         * The same instant into both, and the clock moved forward with it.
         *
         * `now` otherwise carries whatever the one-second interval last wrote,
         * which on the first render after a reply is up to a second stale —
         * and the countdown then opens above 180, claiming more time than the
         * network will actually give. A number nobody can act on, but a wrong
         * one, on the screen whose job is to show this protocol honestly.
         */
        const landed = Date.now()
        setNow(landed)
        setSession({
          ...session,
          text,
          exchanges: [...session.exchanges, exchange],
          // `malformed` ends it: the session cannot continue, because whether
          // the network is still holding it open is exactly what the reply
          // failed to say.
          status: reply.kind === "CON" ? "open" : "ended",
          lastReplyAt: landed,
        })
        setInput("")
      } catch (error) {
        /*
         * A transport failure is never dressed up as a reply.
         *
         * The user is told the gateway could not be reached, which is true and
         * retryable, rather than being shown a screen the server never sent.
         */
        reportError("ussd:dial", error)
        setSession({ ...session, status: "failed", failure: describe(error) })
      }
    },
    [accounts.data?.user.phone, dial],
  )

  const startCall = useCallback(async () => {
    const fresh = newSession(Date.now())
    setSession(fresh)
    setInput("")
    await send(fresh, "", false)
  }, [send])

  const submit = useCallback(async () => {
    if (!session || !live || input === "") return
    await send({ ...session, status: "dialling" }, input, asksForPin(currentReply(session)))
  }, [input, live, send, session])

  /**
   * Sends the same step again, with the same session id.
   *
   * Safe by construction rather than by hope: the adapter derives its
   * idempotency key from `sessionId` and `text`, so a repeat of a step that
   * did reach the server returns that step's stored answer instead of moving
   * money twice. It is also what a real gateway does when a response is lost.
   */
  const retry = useCallback(async () => {
    const attempt = retryable.current
    if (!session || !attempt) return
    await send({ ...session, status: "dialling" }, attempt.input, attempt.secret)
  }, [send, session])

  /* Focus follows the conversation: after a reply the caret is where the next
     digit goes, without the user hunting for it. */
  useEffect(() => {
    if (live) inputRef.current?.focus()
  }, [live])

  const reply = session ? currentReply(session) : undefined
  const secretNext = asksForPin(reply)
  const left = session && !expired ? remainingMs(session, now) : 0

  return (
    <div className="flex flex-col gap-l">
      <PhoneScreen
        reply={status === "failed" ? undefined : reply}
        dialling={isLoading}
        serviceCode={SERVICE_CODE}
      />

      {status === "failed" && session?.failure ? (
        <p
          /* `alert`: it is the answer to something the user just did, and
             everything below it is disabled until they act on it. */
          role="alert"
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{session.failure}</span>
        </p>
      ) : null}

      <SessionLine status={status} remaining={left} />

      {live ? (
        <form
          className="flex flex-col gap-2xs"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <FormField
            label={secretNext ? "PIN kod" : "Javobingiz"}
            hint={secretNext ? "To'rt raqam. Ekranda ko'rinmaydi." : undefined}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                ref={inputRef}
                aria-describedby={describedBy}
                value={input}
                /*
                 * `password` while a PIN is being asked for, mirroring the
                 * `****` §11.7 draws. It hides the digits from the room; it
                 * does not hide them from the wire, and the panel below says
                 * so rather than letting the mask imply otherwise.
                 */
                type={secretNext ? "password" : "text"}
                inputMode="numeric"
                autoComplete="off"
                enterKeyHint="send"
                onChange={(event) => {
                  const next = event.target.value
                  if (ALLOWED_INPUT.test(next)) setInput(next)
                }}
              />
            )}
          </FormField>

          <button
            type="submit"
            disabled={input === "" || isLoading || !online}
            className="flex items-center justify-center gap-2xs rounded-(--radius-control) px-s text-(--color-on-primary)"
            style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
          >
            <PhoneCall size={18} aria-hidden={true} />
            {isLoading ? "Yuborilmoqda…" : "Yuborish"}
          </button>

          {/*
            Said rather than left for the user to deduce from a dead button.
            A USSD dial is never queued: it belongs to a session the network is
            holding open for 180 seconds, and one replayed an hour later would
            be sent into a session that no longer exists — carrying, on the
            last step, a transfer.
          */}
          {online ? null : (
            <p className="m-0 text-step--1" style={{ color: "var(--color-warning)" }}>
              Aloqa yo&apos;q. USSD sessiyasi navbatga qo&apos;yilmaydi — u tarmoq ushlab turgan 180
              soniya ichida yashaydi.
            </p>
          )}

          <Keypad
            disabled={isLoading}
            onKey={(key) => setInput((value) => value + key)}
            onBackspace={() => setInput((value) => value.slice(0, -1))}
          />
        </form>
      ) : (
        <div className="flex flex-col gap-2xs">
          {status === "failed" ? (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={isLoading || !online}
              className="flex items-center justify-center gap-2xs rounded-(--radius-control) px-s text-(--color-on-primary)"
              style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
            >
              <RotateCcw size={18} aria-hidden={true} />
              Shu qadamni qayta yuborish
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => void startCall()}
            disabled={isLoading || !online}
            className="flex items-center justify-center gap-2xs rounded-(--radius-control) border px-s"
            style={{ minHeight: "var(--touch-target-min)", borderColor: "var(--color-neutral)" }}
          >
            <PhoneCall size={18} aria-hidden={true} />
            {session ? `${SERVICE_CODE} — qaytadan terish` : `${SERVICE_CODE} terish`}
          </button>
        </div>
      )}

      {session ? (
        <WirePanel
          session={session}
          phoneNumber={accounts.data?.user.phone ?? "—"}
          networkCode={NETWORK_CODE}
          serviceCode={SERVICE_CODE}
        />
      ) : null}
    </div>
  )
}

/**
 * Where the session stands, in the vocabulary of the protocol rather than of
 * the UI: a `CON` reply means the network is holding it open, and it will stop
 * doing so after 180 idle seconds whether or not anyone is looking.
 */
function SessionLine(props: {
  readonly status: Session["status"] | undefined
  readonly remaining: number | null
}) {
  if (props.status === undefined) return null

  if (props.status === "expired") {
    return (
      <p
        /* `alert`, because it happened without the user doing anything and it
           took their session with it. */
        role="alert"
        className="m-0 flex items-start gap-2xs text-step--1"
        style={{ color: "var(--color-warning)" }}
      >
        <PhoneOff size={16} aria-hidden={true} className="mt-3xs shrink-0" />
        <span>Sessiya tugadi — 180 soniya harakatsiz. Tarmoq uni uzdi, server emas.</span>
      </p>
    )
  }

  if (props.status !== "open" || props.remaining === null) return null

  const seconds = Math.ceil(props.remaining / 1000)

  return (
    <p className="m-0 text-step--1 text-(--color-text-secondary)">
      Sessiya ochiq —{" "}
      {/*
        `timer` with updates off. A countdown wired to a live region would
        interrupt a screen-reader user once a second, which on a 180-second
        timer is 180 interruptions to say a number they did not ask for. The
        expiry itself is announced, because that is the part that matters.
      */}
      <span role="timer" aria-live="off" className="tabular">
        {seconds}
      </span>{" "}
      soniya qoldi
    </p>
  )
}

/**
 * A transport failure in words, kept distinct from anything the server said.
 *
 * Every branch names the gateway rather than the wallet: a user who is told
 * "transfer failed" when the request never left the browser has been told
 * something false about their money.
 */
function describe(error: unknown): string {
  const status = (error as { status?: unknown } | undefined)?.status

  if (status === "FETCH_ERROR") return "Shlyuzga ulanib bo'lmadi. Javob kelmadi."
  if (typeof status === "number") return `Shlyuz ${status} bilan javob berdi.`
  return "Shlyuz bilan aloqa uzildi."
}
