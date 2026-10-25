/**
 * Light/dark theme selection. The console is dark by default; the toggle in the
 * sidebar can pick light, or follow the operating system (`prefers-color-scheme`). The
 * choice is stored in localStorage, which is a per-browser convenience only.
 *
 * The theme is applied as `data-theme` on `<html>` ("dark", "light" or "system");
 * styles.css defines the color tokens for each value (no attribute at all, before the
 * script runs, is dark too), so no inline styles are needed (strict CSP).
 */

/** `system` follows the OS setting. */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "mongoshield.theme";

/** The choice when nothing is stored: the console's own dark look. */
export const DEFAULT_THEME: ThemeChoice = "dark";

/** The stored choice, or the dark default when none is stored or storage is unavailable. */
export function storedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
  } catch {
    // Storage can throw in private windows or when blocked; the default is fine.
    return DEFAULT_THEME;
  }
}

/** Applies a theme to the page and remembers it. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
  try {
    if (choice === DEFAULT_THEME) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not remembering the theme is harmless.
  }
}

/** The next choice when the toggle is pressed: dark → light → system → dark. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === "dark") return "light";
  if (choice === "light") return "system";
  return "dark";
}
