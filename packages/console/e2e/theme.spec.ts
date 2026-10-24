/**
 * The theme toggle: system → light → dark → system. "System" follows the
 * operating system's color scheme; a pinned theme wins over it, survives a
 * reload and also applies to the login page. Checked on the real page colors,
 * not only on the `data-theme` attribute, so a broken stylesheet would fail too.
 */

import type { Page } from "@playwright/test";
import { ADMIN } from "./env.ts";
import { expect, signIn, signOut, test } from "./fixtures.ts";

/** Whether the page background is dark (relative luminance below one half). */
async function backgroundIsDark(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const color = getComputedStyle(document.body).backgroundColor;
    const [red = 255, green = 255, blue = 255] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.5;
  });
}

async function dataTheme(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => document.documentElement.dataset.theme);
}

test("the theme toggle cycles system, light and dark, and remembers the choice", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, ADMIN);
  const toggle = page.getByRole("button", { name: /^Theme: / });

  await expect(toggle).toHaveText("Theme: system");
  expect(await dataTheme(page)).toBeUndefined();
  expect(await backgroundIsDark(page), "system theme follows a dark OS").toBe(true);

  await toggle.click();
  await expect(toggle).toHaveText("Theme: light");
  await expect(toggle).toHaveAccessibleName("Theme: light. Change theme");
  expect(await dataTheme(page)).toBe("light");
  expect(await backgroundIsDark(page), "light wins over a dark OS").toBe(false);

  await toggle.click();
  await expect(toggle).toHaveText("Theme: dark");
  expect(await backgroundIsDark(page)).toBe(true);

  // Pinned: still dark after a reload with a light OS, and on the login page.
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(toggle).toHaveText("Theme: dark");
  expect(await backgroundIsDark(page)).toBe(true);
  await signOut(page);
  expect(await dataTheme(page)).toBe("dark");
  expect(await backgroundIsDark(page)).toBe(true);

  // Back to following the system, which is light now.
  await signIn(page, ADMIN);
  await toggle.click();
  await expect(toggle).toHaveText("Theme: system");
  expect(await dataTheme(page)).toBeUndefined();
  expect(await backgroundIsDark(page)).toBe(false);
});
