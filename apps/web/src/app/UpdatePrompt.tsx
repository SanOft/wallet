import { useRegisterSW } from "virtual:pwa-register/react"
import { Download } from "lucide-react"
import { reportError } from "../lib/report.js"

/**
 * Offers the new version instead of installing it underneath the user.
 *
 * `registerType: "prompt"` in the Vite config is only half of the decision;
 * this is the other half. The alternative, `autoUpdate`, reloads the page the
 * moment a new build is precached — which on a wallet can land while somebody
 * is halfway through typing an amount, discarding it with no explanation.
 *
 * The bar is not dismissible on purpose, and that is a deliberate trade: it
 * appears only when a genuinely newer build exists, it is one line at the
 * bottom, and a dismissed update prompt is an application that quietly stays
 * old for weeks. If it becomes annoying the answer is to ship less often, not
 * to hide it.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // A service worker that fails to register is the whole of FR-8 not
      // happening, and it produces no other symptom: the app simply never
      // works offline, and nobody finds out until they are on a train.
      reportError("sw:register", error)
    },
  })

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 z-30 flex items-center justify-between gap-s px-s py-2xs text-step--1"
      style={{
        // Above the tab bar, and clear of the home indicator on a phone.
        bottom: "calc(var(--touch-target-min) + var(--safe-bottom))",
        background: "var(--color-surface-sunken)",
        color: "var(--color-text)",
      }}
    >
      <span className="flex items-center gap-2xs">
        <Download size={16} aria-hidden={true} className="shrink-0" />
        Yangi versiya tayyor.
      </span>

      <button
        type="button"
        onClick={() => {
          void updateServiceWorker(true)
        }}
        className="shrink-0 rounded-(--radius-control) px-s text-(--color-on-primary)"
        style={{ minHeight: "var(--touch-target-min)", background: "var(--color-primary)" }}
      >
        Yangilash
      </button>
    </div>
  )
}
