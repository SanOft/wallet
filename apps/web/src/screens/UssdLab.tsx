import { ArrowLeft } from "lucide-react"
import { Link } from "react-router"
import { ErrorBoundary } from "../components/ErrorBoundary.js"
import { UssdSimulator } from "../features/ussd/UssdSimulator.js"

/**
 * §13.3's "USSD simulator (labs)", reached from the profile.
 *
 * Labs rather than a feature, and the distinction is honest rather than
 * modest: nobody with a smartphone and this app installed would dial a
 * shortcode. The channel exists for the person who has neither, and this page
 * is the only way to see it work without a real gateway contract (FR-9.6).
 */
export function UssdLab() {
  return (
    <div className="flex flex-col gap-l">
      <header className="flex flex-col gap-2xs">
        <Link
          to="/profile"
          className="flex items-center gap-3xs text-step--1 text-(--color-text-secondary)"
          style={{ width: "fit-content" }}
        >
          <ArrowLeft size={16} aria-hidden={true} />
          Profil
        </Link>

        <h1 className="m-0 text-step-3">USSD simulyatori</h1>

        <p className="m-0 text-(--color-text-secondary)">
          Internetsiz telefondan <code>*880#</code> terilganda nima bo&apos;lishini ko&apos;rsatadi.
          Pastdagi tugmalar haqiqiy serverga haqiqiy shlyuz yuboradigan so&apos;rovni yuboradi — pul
          ham haqiqatan ko&apos;chadi.
        </p>
      </header>

      {/*
        Its own boundary. This page reads a balance and moves money through the
        same service the wizard uses; if it throws, the person needs the tab bar
        and a way back to their account, not a white screen.
      */}
      <ErrorBoundary scope="ussd" title="Simulyatorni ko'rsatib bo'lmadi.">
        <UssdSimulator />
      </ErrorBoundary>
    </div>
  )
}
