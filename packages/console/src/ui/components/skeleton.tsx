/**
 * Skeleton loaders: grey placeholder bars in the shape of what is coming (table rows,
 * cards), so the page does not jump when data arrives. Announced to screen readers as a
 * normal loading status with a label; the bars themselves are hidden from them.
 * The shimmer animation stops for people who prefer reduced motion (styles.css).
 */

/** Widths of the placeholder bars, cycled per row so they do not look like a grid of equals. */
const WIDTHS = ["92%", "76%", "84%", "64%", "88%", "70%"];

/** A stack of placeholder rows. */
export function Skeleton(props: { label: string; rows?: number; variant?: "rows" | "cards" }) {
  const rows = props.rows ?? 6;
  return (
    <div className={`skeleton skeleton-${props.variant ?? "rows"}`} role="status">
      {Array.from({ length: rows }, (_, index) => (
        <span
          // Placeholders have no identity; the index is their key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          key={index}
          className="skeleton-bar"
          aria-hidden="true"
          style={{ width: WIDTHS[index % WIDTHS.length] }}
        />
      ))}
      <span className="visually-hidden">{props.label}</span>
    </div>
  );
}
