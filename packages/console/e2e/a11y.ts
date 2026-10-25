/**
 * A small accessibility smoke check without axe: the problems that most often
 * slip into a page, read from what Chromium exposes to assistive technology.
 *
 *   landmarks      a `main` landmark (plus banner and navigation in the console shell)
 *   heading        a level-1 heading on every page (the shell moves focus to it)
 *   form controls  every textbox, combobox, checkbox, radio, spin button and slider
 *                  has an accessible name (a label, aria-label or aria-labelledby)
 *   buttons        every button and link has an accessible name
 *   images         every `<img>` has an `alt` (empty for decorative ones), and every
 *                  exposed image (`role=img`, svg included) has a name
 *
 * Names come from Playwright's ARIA snapshot, which lists each node as
 * `- role "name"`; an interactive node without a quoted name has none. The DOM is
 * also checked for `<img>` without `alt`, which a snapshot would not reveal (it
 * may expose the file name instead).
 */

import type { Page } from "@playwright/test";

/** Roles that must always have an accessible name. */
const NAMED_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "spinbutton",
  "slider",
  "img",
  "tab",
  "dialog",
] as const;

/**
 * One line of an ARIA snapshot: indentation, `- `, an optional YAML quote, the
 * role, and then optionally ` "name"`. Examples:
 *   - button "Sign out"
 *   - 'button "Theme: dark. Change theme"': "Theme: dark"
 *   - textbox
 */
const SNAPSHOT_LINE = /^\s*-\s+'?([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/;

/** What the check found; empty when the page passes. */
export async function accessibilityProblems(
  page: Page,
  options: { readonly shell?: boolean } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = await page.locator("body").ariaSnapshot();
  const roles = new Set<string>();

  for (const line of snapshot.split("\n")) {
    const match = SNAPSHOT_LINE.exec(line);
    if (match === null) continue;
    const role = match[1] ?? "";
    const name = match[2] ?? "";
    roles.add(role);
    if (role === "heading" && line.includes("[level=1]")) roles.add("heading-1");
    if (NAMED_ROLES.some((named) => named === role) && name.trim() === "") {
      problems.push(`unnamed ${role}: ${line.trim()}`);
    }
  }

  // A modal dialog hides the rest of the page from the snapshot; its own landmarks do not count.
  const dialogOpen = roles.has("dialog");
  if (!dialogOpen && !roles.has("main")) problems.push("no main landmark");
  if (!dialogOpen && !roles.has("heading-1")) problems.push("no level-1 heading");
  if (!dialogOpen && options.shell === true) {
    if (!roles.has("banner")) problems.push("no banner landmark");
    if (!roles.has("navigation")) problems.push("no navigation landmark");
  }

  const imagesWithoutAlt = await page.locator("img:not([alt])").count();
  if (imagesWithoutAlt > 0) problems.push(`${imagesWithoutAlt} <img> without alt`);

  // Belt and braces for controls: the DOM must give every visible control a label.
  const unlabelled = await page.evaluate(() => {
    const controls = document.querySelectorAll<HTMLElement>(
      "input:not([type=hidden]), select, textarea",
    );
    const missing: string[] = [];
    for (const control of controls) {
      if (control.offsetParent === null && control.getClientRects().length === 0) continue;
      const labelled =
        (control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) &&
        (control.labels?.length ?? 0) > 0;
      const named =
        (control.getAttribute("aria-label") ?? "").trim() !== "" ||
        (control.getAttribute("aria-labelledby") ?? "").trim() !== "" ||
        (control.getAttribute("title") ?? "").trim() !== "";
      if (!labelled && !named) missing.push(control.outerHTML.slice(0, 120));
    }
    return missing;
  });
  for (const control of unlabelled) problems.push(`control without a label: ${control}`);

  return problems;
}
