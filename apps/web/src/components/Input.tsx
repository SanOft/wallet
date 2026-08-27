import type { InputHTMLAttributes } from "react"

/**
 * The one text input every other field is built from.
 *
 * `font-size` comes from `--text-step-0`, whose minimum is 16px, and that is
 * not an aesthetic choice: iOS Safari zooms the page when a focused input's
 * text is smaller, which throws the layout sideways mid-typing and cannot be
 * undone without a pinch. §13.2.3 records it as a hard rule; this is where it
 * is spent.
 *
 * The height is the touch target rather than a line height, so a finger on a
 * 360px screen lands inside the field and not next to it (NFR-3).
 */

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style"> & {
  readonly invalid?: boolean
}

export function Input({ invalid = false, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className="w-full rounded-(--radius-control) border bg-(--color-background) px-2xs text-(--color-text)"
      style={{
        minHeight: "var(--touch-target-min)",
        fontSize: "var(--text-step-0)",
        borderColor: invalid ? "var(--color-danger)" : "var(--color-neutral)",
      }}
    />
  )
}
