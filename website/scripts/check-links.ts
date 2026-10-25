/**
 * Checks every internal link in the built site (dist/): the page must exist, and an
 * `#anchor` must match an `id` on that page. Exits 1 and lists the broken links.
 *
 * Starlight does not validate links itself, and links between docs/ files are
 * rewritten by sync-docs.ts, so this is what catches a renamed guide or heading.
 * Run after `astro build`: `node scripts/check-links.ts` (DOCS_BASE as for the build).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { REPO_ROOT } from "./lib.ts";

const DIST = join(REPO_ROOT, "website", "dist");
const BASE = `${(process.env.DOCS_BASE ?? "/mongoshield").replace(/\/+$/, "")}/`;

/** Every .html file under a directory. */
function htmlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...htmlFiles(path));
    else if (entry.endsWith(".html")) files.push(path);
  }
  return files;
}

/** The site URL of a built file: dist/guides/atlas/index.html → /base/guides/atlas/. */
function urlOf(file: string): string {
  const path = relative(DIST, file).split("\\").join("/");
  return BASE + path.replace(/(^|\/)index\.html$/, "$1");
}

/** The built file for a site path, or undefined when it is outside the site. */
function fileOf(pathname: string): string | undefined {
  if (!pathname.startsWith(BASE)) return undefined;
  const inside = decodeURIComponent(pathname.slice(BASE.length));
  return join(DIST, inside === "" || inside.endsWith("/") ? `${inside}index.html` : inside);
}

/** The ids on a page, cached because many links point at the same pages. */
const idsByFile = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idsByFile.get(file);
  if (!ids) {
    const html = readFileSync(file, "utf8");
    ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""));
    idsByFile.set(file, ids);
  }
  return ids;
}

function main(): void {
  if (!existsSync(DIST)) throw new Error("dist/ not found: run `astro build` first");
  const broken: string[] = [];
  let checked = 0;

  for (const file of htmlFiles(DIST)) {
    const pageUrl = urlOf(file);
    const html = readFileSync(file, "utf8");
    for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = (match[1] ?? "").replace(/&amp;/g, "&");
      // External links, mail links and data URIs are not checked.
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;

      const target = new URL(raw, `https://site.invalid${pageUrl}`);
      const targetFile = fileOf(target.pathname);
      checked += 1;
      if (!targetFile || !existsSync(targetFile)) {
        broken.push(`${pageUrl}: ${raw} (no such page)`);
        continue;
      }
      const anchor = decodeURIComponent(target.hash.slice(1));
      if (anchor && targetFile.endsWith(".html") && !idsOf(targetFile).has(anchor)) {
        broken.push(`${pageUrl}: ${raw} (no #${anchor} on ${posix.normalize(target.pathname)})`);
      }
    }
  }

  if (broken.length > 0) {
    console.error(`check-links: ${broken.length} broken internal links\n  ${broken.join("\n  ")}`);
    process.exit(1);
  }
  process.stdout.write(`check-links: ${checked} internal links OK\n`);
}

main();
