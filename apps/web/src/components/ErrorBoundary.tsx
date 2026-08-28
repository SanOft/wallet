import { TriangleAlert } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode } from "react"
import { reportError } from "../lib/report.js"

/**
 * The difference between one broken widget and a white screen.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * On this application that means: a blank page, no navigation, no explanation,
 * and — for anyone who was looking at their balance a second earlier — no way
 * to tell a rendering bug from a stolen account. It is the worst failure mode
 * the product has, and until now nothing prevented it.
 *
 * Boundaries are placed per section rather than only at the root. A root-only
 * boundary turns any single fault into "the whole app is down", which is both
 * less true and less useful than "the rates widget is down and your balance is
 * right there".
 *
 * A class, because `getDerivedStateFromError` has no hook equivalent — this is
 * the one component in the codebase that cannot be a function.
 */

interface Props {
  /** Named in the report, so a console line says which part failed. */
  readonly scope: string
  /** What the user is told. Defaults to something true but unspecific. */
  readonly title?: string
  readonly children: ReactNode
}

interface State {
  readonly failed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The whole point. React logs to the console in development and says
    // nothing in production, so without this line a released build fails
    // silently by design.
    reportError(`render:${this.props.scope}`, error, { componentStack: info.componentStack })
  }

  #retry = () => {
    this.setState({ failed: false })
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children

    return (
      <section
        // `alert`: something the user was looking at has gone, and they are
        // owed that news immediately rather than at the next pause.
        role="alert"
        className="flex flex-col items-start gap-2xs rounded-(--radius-card) p-s"
        style={{ background: "var(--color-surface-sunken)" }}
      >
        <p
          className="m-0 flex items-start gap-2xs text-step--1"
          style={{ color: "var(--color-danger)" }}
        >
          <TriangleAlert size={16} aria-hidden={true} className="mt-3xs shrink-0" />
          {/*
            Says what is missing, not "something went wrong". A user who is
            told the rates failed knows their balance is still trustworthy;
            a user told "an error occurred" does not.
          */}
          <span>{this.props.title ?? "Bu qismni ko'rsatib bo'lmadi."}</span>
        </p>

        <button
          type="button"
          onClick={this.#retry}
          className="rounded-(--radius-control) px-s text-(--color-on-primary)"
          style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
        >
          Qayta urinish
        </button>
      </section>
    )
  }
}
