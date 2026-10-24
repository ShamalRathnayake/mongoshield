/**
 * Copies the repository README into this package directory, so the npm tarball
 * (and the package page on npmjs.com) shows it. npm only packs a README that sits
 * next to package.json, and the real one lives at the repository root.
 *
 * Runs automatically as the package's `prepack` script, i.e. before `pnpm pack`,
 * `pnpm publish` (which changesets runs) and `npm pack`. Run by hand with:
 *   node scripts/prepare-package-readme.ts      (from packages/mongoshield)
 *
 * Relative links (`./docs/guides`, `./SECURITY.md`) point at files in the
 * repository, which are not in the tarball, so they are rewritten to absolute
 * GitHub URLs. Anchors (`#roadmap`) and absolute URLs are left alone.
 *
 * The generated packages/mongoshield/README.md is git-ignored: edit the root
 * README.md instead. When the root README is not there (the Docker image build
 * copies only this package directory), the script does nothing; the image never
 * shows a README anyway.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where repository-relative links point after the rewrite. */
const REPOSITORY_BLOB_URL = "https://github.com/ShamalRathnayake/mongoshield/blob/main/";

/** The README at the repository root (two levels above this package). */
const SOURCE = fileURLToPath(new URL("../../../README.md", import.meta.url));

/** The README npm packs: next to this package's package.json. */
const TARGET = fileURLToPath(new URL("../README.md", import.meta.url));

/** First line of the generated file, so nobody edits the copy by mistake. */
const GENERATED_NOTICE =
  "<!-- Generated from the repository README by scripts/prepare-package-readme.ts. Edit ../../README.md instead. -->\n\n";

/**
 * Rewrites the targets of inline Markdown links (`[text](target)`) that are
 * relative to the repository root. `./docs/x.md` and `docs/x.md` both become
 * `https://github.com/…/blob/main/docs/x.md`. GitHub redirects `blob/` URLs of
 * directories to their `tree/` view, so folder links work too.
 */
function absolutizeRelativeLinks(markdown: string): string {
  // `](` starts a link target; capture up to the closing parenthesis or a space
  // (a space starts an optional link title, which is kept as is).
  return markdown.replace(/\]\(([^)\s]+)/g, (match, target: string) => {
    if (!isRepositoryRelative(target)) return match;
    const withoutDotSlash = target.startsWith("./") ? target.slice(2) : target;
    return `](${REPOSITORY_BLOB_URL}${withoutDotSlash}`;
  });
}

/** True for link targets that name a file in the repository rather than a URL or anchor. */
function isRepositoryRelative(target: string): boolean {
  if (target.startsWith("#")) return false; // anchor within the README
  if (target.startsWith("/")) return false; // site-absolute: leave as written
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // https:, mailto:, …
  return true;
}

/** Writes the package README, or explains why it skipped. */
function main(): void {
  if (!existsSync(SOURCE)) {
    // Expected inside the Docker build; anywhere else it would be a mistake.
    process.stderr.write(`prepare-package-readme: ${SOURCE} not found, skipping\n`);
    return;
  }
  const readme = readFileSync(SOURCE, "utf8");
  writeFileSync(TARGET, GENERATED_NOTICE + absolutizeRelativeLinks(readme));
}

main();
