/**
 * A placeholder with the shape of what is coming.
 *
 * Deliberately not a spinner: a spinner says "wait" and nothing else, while a
 * block the size of the balance says the balance is on its way, and the layout
 * does not jump when it arrives. §13.3 asks for skeletons by name.
 *
 * `aria-hidden` throughout. The loading state is announced once by the region
 * that owns it — see `aria-busy` on the card — and a screen reader that also
 * met three decorative rectangles would be told less, not more.
 *
 * The pulse is stilled automatically under `prefers-reduced-motion`
 * (`tokens.css`), which matters here: a permanent shimmer is a migraine
 * trigger, and this one is on the first screen after sign-in.
 */
export function Skeleton(props: { readonly width: string; readonly height: string }) {
  return (
    <span
      aria-hidden="true"
      className="block animate-pulse rounded-(--radius-control)"
      style={{
        width: props.width,
        height: props.height,
        background: "color-mix(in oklab, var(--color-neutral) 25%, transparent)",
      }}
    />
  )
}
