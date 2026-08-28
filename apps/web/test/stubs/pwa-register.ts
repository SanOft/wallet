/**
 * Stands in for `virtual:pwa-register/react`, which only exists while
 * `vite-plugin-pwa` is loaded — and `vitest.config.ts` is a separate config
 * that does not load it.
 *
 * Controllable rather than inert. A stub that always reports "no update"
 * would make the prompt untestable, and an update bar nobody has ever seen
 * render is an update bar that is broken the first time it matters.
 */

let pending = false
let applied = 0

export function __setUpdatePending(value: boolean): void {
  pending = value
}

export function __appliedUpdates(): number {
  return applied
}

export function __resetRegisterSW(): void {
  pending = false
  applied = 0
}

export function useRegisterSW(): {
  needRefresh: [boolean, (value: boolean) => void]
  offlineReady: [boolean, (value: boolean) => void]
  updateServiceWorker: (reload?: boolean) => Promise<void>
} {
  return {
    needRefresh: [pending, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: () => {
      applied++
      return Promise.resolve()
    },
  }
}
