import { Link } from "react-router"

/**
 * §13.1: an error is not a dead end. Even the one screen nobody designs for
 * offers the next step rather than only stating the problem.
 */
export function NotFound() {
  return (
    <div className="flex flex-col items-start gap-s">
      <h1 className="m-0 text-step-3">Sahifa topilmadi</h1>
      <p className="m-0 text-(--color-text-secondary)">
        Bu manzilda hech narsa yo&apos;q. Havola eskirgan bo&apos;lishi mumkin.
      </p>
      <Link
        to="/"
        className="inline-flex items-center rounded-(--radius-control) bg-(--color-primary) px-s text-(--color-on-primary) no-underline"
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        Asosiy sahifaga
      </Link>
    </div>
  )
}
