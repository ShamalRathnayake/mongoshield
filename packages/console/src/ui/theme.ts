/**
 * Light/dark theme selection. By default the console follows the operating system
 * (`prefers-color-scheme`); the toggle in the header can pin light or dark. The choice is
 * stored in localStorage, which is a per-browser convenience only.
 *
 * The theme is applied as `data-theme` on `<html>`; styles.css defines the color tokens
 * for each value, so no inline styles are needed (strict CSP).
 */

/** `system` follows the OS setting. */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "mongoshield.theme";

/** The stored choice, or `system` when none is stored or storage is unavailable. */
export function storedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // Storage can throw in private windows or when blocked; the default is fine.
    return "system";
  }
}

/** Applies a theme to the page and remembers it. */
export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not remembering the theme is harmless.
  }
}

/** The next choice when the toggle is pressed: system → light → dark → system. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === "system") return "light";
  if (choice === "light") return "dark";
  return "system";
}
