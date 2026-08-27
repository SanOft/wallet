import { ThemeToggle } from "../app/ThemeToggle.js"
import { FormShowcase } from "./FormShowcase.js"

/**
 * F0's Home is the design system itself.
 *
 * The phase's definition of done asks for a visual check at 320, 360, 768 and
 * 1280px and for dark mode to work. Neither is checkable against three empty
 * screens, so this renders the scales and the semantic colours instead: at four
 * widths the type and space steps visibly interpolate, and the toggle proves
 * that re-declaring layer 2 is enough. The real Home (FR-3, balance card, §13.4)
 * replaces it at F3.
 */

const TYPE_STEPS = [
  { token: "--text-step-4", use: "Balans" },
  { token: "--text-step-3", use: "Ekran sarlavhasi" },
  { token: "--text-step-2", use: "Bo'lim sarlavhasi" },
  { token: "--text-step-1", use: "Kichik sarlavha" },
  { token: "--text-step-0", use: "Asosiy matn" },
  { token: "--text-step--1", use: "Yordamchi matn" },
] as const

const SPACE_STEPS = [
  "--spacing-3xs",
  "--spacing-2xs",
  "--spacing-xs",
  "--spacing-s",
  "--spacing-m",
  "--spacing-l",
  "--spacing-xl",
  "--spacing-2xl",
] as const

const SEMANTIC = [
  { token: "--color-primary", on: "--color-on-primary", use: "CTA, havola, faol tab" },
  { token: "--color-success", on: "--color-background", use: "COMPLETED, kirim" },
  { token: "--color-danger", on: "--color-background", use: "FAILED, chiqim, xato" },
  { token: "--color-warning", on: "--color-background", use: "PENDING, eskirgan ma'lumot" },
  { token: "--color-neutral", on: "--color-background", use: "QUEUED, o'chirilgan" },
] as const

export function Home() {
  return (
    <div className="flex flex-col gap-l">
      <header className="flex items-start justify-between gap-s">
        <div>
          <h1 className="m-0 text-step-3">Dizayn tizimi</h1>
          <p className="m-0 text-step--1 text-(--color-text-secondary)">
            Spec §13.2 — uch qatlam, tekshirilgan kontrast
          </p>
        </div>
        <ThemeToggle />
      </header>

      <section aria-labelledby="type-heading" className="flex flex-col gap-2xs">
        <h2 id="type-heading" className="m-0 text-step-1">
          Shrift shkalasi
        </h2>
        <p className="m-0 text-step--1 text-(--color-text-secondary)">
          Oynani torayting: qiymatlar sakramaydi, oraliqda o&apos;zgaradi.
        </p>
        <ul className="m-0 flex list-none flex-col gap-3xs p-0">
          {TYPE_STEPS.map((step) => (
            <li key={step.token} style={{ fontSize: `var(${step.token})` }}>
              {step.use}{" "}
              <code className="text-step--1 text-(--color-text-secondary)">{step.token}</code>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="space-heading" className="flex flex-col gap-2xs">
        <h2 id="space-heading" className="m-0 text-step-1">
          Oraliq shkalasi
        </h2>
        <ul className="m-0 flex list-none flex-col gap-3xs p-0">
          {SPACE_STEPS.map((token) => (
            <li key={token} className="flex items-center gap-2xs">
              <span
                aria-hidden="true"
                className="block rounded-(--radius-control) bg-(--color-primary)"
                style={{ width: `var(${token})`, height: "var(--spacing-2xs)" }}
              />
              <code className="text-step--1 text-(--color-text-secondary)">{token}</code>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="colour-heading" className="flex flex-col gap-2xs">
        <h2 id="colour-heading" className="m-0 text-step-1">
          Semantik ranglar
        </h2>
        <p className="m-0 text-step--1 text-(--color-text-secondary)">
          Har bir juftlikning kontrasti CI&apos;da WCAG 2.1 formulasi bilan tekshiriladi.
        </p>
        <ul className="m-0 flex list-none flex-col gap-2xs p-0">
          {SEMANTIC.map((entry) => (
            <li
              key={entry.token}
              className="rounded-(--radius-card) p-s"
              style={{
                background: `var(${entry.token})`,
                color: `var(${entry.on})`,
              }}
            >
              <code>{entry.token}</code>
              <span className="block text-step--1">{entry.use}</span>
            </li>
          ))}
        </ul>
      </section>

      <FormShowcase />

      <section aria-labelledby="money-heading" className="flex flex-col gap-2xs">
        <h2 id="money-heading" className="m-0 text-step-1">
          Summa formati
        </h2>
        <p className="m-0 text-step--1 text-(--color-text-secondary)">
          Raqamlar bir xil kenglikda — ustunda solishtirish uchun (§13.2.4).
        </p>
        <p className="tabular m-0 text-step-4">1 250 000 so&apos;m</p>
        <p className="tabular m-0 text-step-0 text-(--color-success)">+ 300 000 so&apos;m</p>
        <p className="tabular m-0 text-step-0 text-(--color-danger)">− 1 111 111 so&apos;m</p>
      </section>
    </div>
  )
}
