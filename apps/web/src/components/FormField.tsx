import { TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { useId } from "react"

/**
 * Label, control, error — wired together the way §13.8.2 requires.
 *
 * Three of that table's rows meet here. One `label` per input, joined by
 * `for`/`id`, because a placeholder is not a label: it vanishes the moment
 * typing starts, exactly when the user most needs to be told what the field
 * was. The error sits *below* the field and is announced through
 * `aria-describedby`, so a screen reader reaches it as part of the field
 * rather than as loose text elsewhere on the page. And the message carries an
 * icon as well as colour, because colour is never the only signal (NFR-4).
 *
 * The control is a render prop rather than a cloned child: cloning would put
 * the accessibility wiring somewhere a reader has to infer it, and this way
 * the ids are visibly handed over.
 */

export interface FieldRenderProps {
  readonly id: string
  readonly describedBy: string | undefined
  readonly invalid: boolean
}

export function FormField(props: {
  readonly label: string
  readonly error?: string | undefined
  /** Shown under the label, before any error. For rules a user needs up front. */
  readonly hint?: string | undefined
  readonly children: (field: FieldRenderProps) => ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  const describedBy =
    [props.hint ? hintId : undefined, props.error ? errorId : undefined]
      .filter(Boolean)
      .join(" ") || undefined

  return (
    <div className="flex flex-col gap-3xs">
      <label htmlFor={id} className="text-step--1 text-(--color-text-secondary)">
        {props.label}
      </label>

      {props.hint ? (
        <p id={hintId} className="m-0 text-step--1 text-(--color-text-secondary)">
          {props.hint}
        </p>
      ) : null}

      {props.children({ id, describedBy, invalid: Boolean(props.error) })}

      {props.error ? (
        <p
          id={errorId}
          className="m-0 flex items-start gap-3xs text-step--1 text-(--color-danger)"
          // Announced when it appears, without stealing focus from the field
          // the user is still standing in.
          role="status"
        >
          {/* Hidden from assistive technology on purpose: the sentence beside
              it already says what is wrong, and announcing "warning triangle"
              first only delays reaching it. The icon exists for the reader who
              cannot rely on the colour. */}
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          <span>{props.error}</span>
        </p>
      ) : null}
    </div>
  )
}
