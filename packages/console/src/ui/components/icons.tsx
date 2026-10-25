/**
 * Small line icons (16 × 16, drawn with `currentColor`), inline SVG so they follow the
 * theme and need no extra requests (the CSP allows no external images anyway).
 *
 * Icons are decoration: they are `aria-hidden`, and every control that shows one also
 * has a text label or an `aria-label`. Shapes are kept simple so they read at 16 px.
 */

/** Every icon by name: the SVG path data on a 16 × 16 grid. */
const PATHS = {
  // A database: a cylinder.
  database:
    "M2.5 4c0-1.1 2.5-2 5.5-2s5.5.9 5.5 2v8c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2zM2.5 4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2",
  // A collection: stacked sheets.
  collection: "M3 3.5h10v3H3zM3 9.5h10v3H3zM5 6.5v3M11 6.5v3",
  // A view: an eye.
  view: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  // A time series collection: a clock.
  timeseries: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM8 4.5V8l2.5 1.5",
  // A capped collection: a ring buffer (circle with an arrow).
  capped: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  // A connection (a server).
  server: "M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11zM5 4.75h.01M5 11.25h.01",
  search: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.3 10.3l3.2 3.2",
  chevronRight: "M6 3.5 10.5 8 6 12.5",
  chevronDown: "M3.5 6 8 10.5 12.5 6",
  chevronLeft: "M10 3.5 5.5 8l4.5 4.5",
  // View modes.
  table: "M2 3h12v10H2zM2 6.5h12M2 10h12M6 3v10",
  tree: "M3 2.5v9.5h3M3 7h3M6 5.5h7v3H6zM6 10.5h7v3H6z",
  json: "M5.5 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 1.5-1.5 2 1 .5 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 1.5 1.5 2-1 .5-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2",
  cards: "M2 2.5h5v5H2zM9 2.5h5v5H9zM2 9.5h5v4H2zM9 9.5h5v4H9z",
  schema: "M2.5 3h4M2.5 6.5h7M2.5 10h5M2.5 13.5h9M11 3h2.5M12.5 10h1",
  chart: "M2.5 13.5h11M4 13.5V8M7 13.5V4M10 13.5V9.5M13 13.5V6",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  filter: "M2 3h12L9.5 8.5v4l-3 1.5v-5.5z",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5V5H5M8 5v3l2 1.5",
  columns: "M2 3h12v10H2zM6 3v10M10 3v10",
  expand: "M5.5 2.5h-3v3M10.5 2.5h3v3M5.5 13.5h-3v-3M10.5 13.5h3v-3",
  collapse: "M2.5 5.5h3v-3M13.5 5.5h-3v-3M2.5 10.5h3v3M13.5 10.5h-3v3",
  open: "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4",
  key: "M10 2.5a3.5 3.5 0 1 1-2.9 5.5L2.5 12.6v1.9h2v-1.5H6v-1.5h1.5l1-1A3.5 3.5 0 0 1 10 2.5zM10.5 5h.01",
  arrowUp: "M8 13V3M4 7l4-4 4 4",
  arrowDown: "M8 3v10M4 9l4 4 4-4",
  check: "M3 8.5 6.5 12 13 4.5",
  wrap: "M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8M9.5 10.5 8 12l1.5 1.5M2.5 12h3",
  refresh: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  edit: "M10.5 2.5l3 3-8 8h-3v-3z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  duplicate: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3M9.5 8v3M8 9.5h3",
  // Sparkles: one-click suggestions under a field.
  sparkle:
    "M7 1.5l1.3 3.7 3.7 1.3-3.7 1.3L7 11.5 5.7 7.8 2 6.5l3.7-1.3zM12.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  // A crossed-out eye: "hide" on password fields (the plain eye is `view`).
  eyeOff:
    "M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.3 4.4C2.6 5.6 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.5-.4 3.4-1.1M7 3.6l1-.1c4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.6 2.2",
  // Navigation: one icon per section of the sidebar.
  dashboard: "M2.5 2.5h4.5v5.5H2.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 10h4.5v3.5H2.5z",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M5.5 9.5h1M9.5 9.5h1M5.5 11.5h1",
  archive: "M2 3h12v3H2zM3 6v7.5h10V6M6.5 8.5h3",
  activity: "M1.5 8h3l2-5 3 10 2-5h3",
  drive: "M2 9.5 4 3.5h8l2 6M2 9.5h12v4H2zM11 11.5h.01",
  audit: "M4.5 2.5h7a1 1 0 0 1 1 1v10h-8a1 1 0 0 1-1-1zM6 5.5h4.5M6 8h4.5M6 10.5h2.5",
  users:
    "M6 7a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 6 7zM1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M10.5 2.7a2.25 2.25 0 0 1 0 4.1M12 9.7c1.5.5 2.5 1.8 2.5 3.8",
  sliders: "M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3",
  // The theme toggle and signing out.
  sun: "M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z",
  monitor: "M2 3h12v8H2zM6 14h4M8 11v3",
  logout: "M6 2.5H3.5v11H6M10 5l3 3-3 3M13 8H6.5",
  // Overview tiles.
  shield: "M8 1.5 13.5 3.5v4c0 3.3-2.3 6.1-5.5 7-3.2-.9-5.5-3.7-5.5-7v-4z",
  alert: "M8 2 14.5 13.5h-13zM8 6.5v3M8 11.5h.01",
  clock: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM8 4.5V8l2.5 1.5",
  play: "M5 3.5v9l7-4.5z",
} as const;

/** The names of the available icons. */
export type IconName = keyof typeof PATHS;

/** One icon. `size` in pixels (default 16). Always hidden from assistive technology. */
export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const size = props.size ?? 16;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={`icon ${props.className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** The icon of a collection type (capped collections get their own). */
export function collectionIcon(
  type: "collection" | "view" | "timeseries",
  capped?: boolean,
): IconName {
  if (type === "view") return "view";
  if (type === "timeseries") return "timeseries";
  return capped === true ? "capped" : "collection";
}
