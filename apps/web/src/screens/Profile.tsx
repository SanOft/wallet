import { ChevronRight, Smartphone } from "lucide-react"
import { Link } from "react-router"

/** Placeholder. §13.4 gives this screen its shape; it is built alongside F2. */
export function Profile() {
  return (
    <div className="flex flex-col gap-l">
      <div className="flex flex-col gap-2xs">
        <h1 className="m-0 text-step-3">Profil</h1>
        <p className="m-0 text-(--color-text-secondary)">
          Ism, niqoblangan raqam, sessiyalar va PIN holati keyingi bosqichlarda.
        </p>
      </div>

      {/*
        §13.3's nav map hangs the simulator off this screen, and the link goes
        in now rather than with the rest of the profile: a route nothing links
        to is a route nobody finds, and F7's whole purpose is to be shown.
      */}
      <Link
        to="/labs/ussd"
        className="flex items-center gap-2xs rounded-(--radius-card) p-s"
        style={{ background: "var(--color-surface-sunken)", minHeight: "var(--touch-target-min)" }}
      >
        <Smartphone size={20} aria-hidden={true} className="shrink-0" />
        <span className="flex flex-col">
          <span>USSD simulyatori</span>
          <span className="text-step--1 text-(--color-text-secondary)">
            Internetsiz telefondan <code>*880#</code>
          </span>
        </span>
        <ChevronRight
          size={18}
          aria-hidden={true}
          className="shrink-0 text-(--color-text-secondary)"
          style={{ marginInlineStart: "auto" }}
        />
      </Link>
    </div>
  )
}
