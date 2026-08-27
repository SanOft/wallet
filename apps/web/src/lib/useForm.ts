import { type FormEvent, useCallback, useMemo, useState } from "react"
import type * as z from "zod"
import { type FieldErrors, fromZod } from "./fieldErrors.js"

/**
 * The Zod ↔ form binding of §15's F0.5, following §13.8.2's policy exactly.
 *
 * Three rules from that table drive the whole design:
 *
 * - **Timing.** Validate during entry, not only on submit — but only for the
 *   field the user has finished with. Validating the whole form on the first
 *   keystroke lights up fields nobody has reached yet, which reads as being
 *   told off for work not yet done.
 * - **Submit.** The button is *not* disabled up front. web.dev's guidance is
 *   blunt about why: a dead button leaves the user guessing which field is at
 *   fault. It goes dead only once pressed, which is the S-6 double-tap defence.
 * - **Everything at once.** On submit every failing field is shown, so the user
 *   fixes the form once rather than discovering faults one at a time.
 */

export interface FieldBinding {
  readonly name: string
  readonly value: string
  readonly error: string | undefined
  readonly onChange: (value: string) => void
  readonly onBlur: () => void
}

export interface Form<T> {
  readonly values: Readonly<Record<string, string>>
  readonly errors: FieldErrors
  readonly submitting: boolean
  readonly field: (name: keyof T & string) => FieldBinding
  readonly handleSubmit: (event: FormEvent) => void
  /** §12.3's `details`, applied to the same fields the client validates. */
  readonly setErrors: (errors: FieldErrors) => void
}

export function useForm<T>(options: {
  schema: z.ZodType<T>
  initial: Record<string, string>
  onSubmit: (value: T) => void | Promise<void>
}): Form<T> {
  const { schema, initial, onSubmit } = options

  const [values, setValues] = useState<Record<string, string>>(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)

  /** Validates everything, and returns the faults keyed by field. */
  const faults = useCallback(
    (candidate: Record<string, string>): FieldErrors => {
      const result = schema.safeParse(candidate)
      return result.success ? {} : fromZod(result.error)
    },
    [schema],
  )

  const field = useCallback(
    (name: string): FieldBinding => ({
      name,
      value: values[name] ?? "",
      error: errors[name],
      onChange: (value: string) => {
        setValues((current) => ({ ...current, [name]: value }))
        // Typing clears this field's complaint but raises none: a message that
        // appears mid-word is a message about an unfinished value.
        setErrors((current) => {
          if (!(name in current)) return current
          const { [name]: _cleared, ...rest } = current
          return rest
        })
      },
      onBlur: () => {
        // Only this field's fault surfaces. The others are still being worked on.
        const found = faults(values)[name]
        setErrors((current) => (found ? { ...current, [name]: found } : current))
      },
    }),
    [values, errors, faults],
  )

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      if (submitting) return

      const found = faults(values)
      if (Object.keys(found).length > 0) {
        setErrors(found)
        return
      }

      const parsed = schema.safeParse(values)
      if (!parsed.success) return

      setSubmitting(true)
      void Promise.resolve(onSubmit(parsed.data)).finally(() => setSubmitting(false))
    },
    [faults, onSubmit, schema, submitting, values],
  )

  return useMemo(
    () => ({ values, errors, submitting, field, handleSubmit, setErrors }),
    [values, errors, submitting, field, handleSubmit],
  )
}
