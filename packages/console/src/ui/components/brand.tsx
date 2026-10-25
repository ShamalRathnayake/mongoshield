/**
 * The MongoShield logo: a shield with a check mark on a rounded tile. The tile's
 * gradient comes from styles.css (`.brand-logo`), so it follows the theme.
 *
 * Decorative: every place that shows it also shows the name "MongoShield" as text.
 */

/** The logo tile alone. `size` is the tile's width and height in pixels (default 28). */
export function BrandLogo(props: { size?: number }) {
  const size = props.size ?? 28;
  return (
    <span className="brand-logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={size * 0.6}
        height={size * 0.6}
        aria-hidden="true"
        focusable="false"
      >
        {/* The shield outline, then the check mark inside it. */}
        <path
          d="M12 2.5 19.5 5.3v5.6c0 4.6-3.1 8.6-7.5 10-4.4-1.4-7.5-5.4-7.5-10V5.3z"
          fill="currentColor"
          fillOpacity="0.18"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="m8.6 12.2 2.4 2.4 4.6-4.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
