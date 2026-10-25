/**
 * Copies the repository's Markdown docs into the website.
 *
 *   docs/guides/*.md  →  src/content/docs/guides/<name>.md
 *   docs/specs/*.md   →  src/content/docs/specs/<name in lower case>.md
 *   docs/errors.md    →  src/content/docs/reference/errors.md
 *   docs/benchmarks.md → src/content/docs/compare/benchmarks.md
 *
 * The files in docs/ stay the source of truth and keep working on GitHub. For the
 * site, each copy gets:
 *
 * - frontmatter: the title from the first `# heading` (which is then removed, since
 *   Starlight renders the title itself), a description from the first paragraph,
 *   an "Edit page" link to the original file, and a sidebar position;
 * - rewritten links: relative `.md` links between published docs become site links
 *   (`../specs/FORMAT.md#the-manifest` → `/specs/format/#the-manifest`), and links to
 *   other repository files (examples, deploy manifests, source) become GitHub links.
 *   Site links are root-relative; the remark plugin in src/plugins adds the base path.
 *
 * Run with `node scripts/sync-docs.ts` (Node 24 strips the types).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import {
  CONTENT_DIR,
  generatedNotice,
  githubEditUrl,
  githubViewUrl,
  REPO_ROOT,
  renderFrontmatter,
  resetDirectory,
  writePage,
} from "./lib.ts";

/** One group of source files and where its pages go on the site. */
interface Collection {
  /** Directory under the repository root. */
  readonly sourceDir: string;
  /** Directory under src/content/docs, which is also the URL prefix. */
  readonly targetDir: string;
  /**
   * Sidebar order by file name (without `.md`). Files not listed (a guide added
   * later) still appear, after the listed ones, in alphabetical order.
   */
  readonly order: readonly string[];
}

const COLLECTIONS: readonly Collection[] = [
  {
    sourceDir: "docs/guides",
    targetDir: "guides",
    order: [
      // Where to run backups.
      "scheduling",
      "docker",
      "kubernetes",
      "kubernetes-operator",
      "github-actions",
      "aws-lambda",
      "vercel",
      "atlas",
      "atlas-free-tier",
      "bun-and-deno",
      // Operating them.
      "observability",
      "immutable-backups",
      "point-in-time-recovery",
      "incremental-backups",
      "upgrade-rehearsal",
      // Other data workflows.
      "staging-data",
      "testing",
      "mongodump",
    ],
  },
  {
    sourceDir: "docs/specs",
    targetDir: "specs",
    order: ["FORMAT", "ENCRYPTION", "CONSISTENCY", "PARTS-AND-RESUME", "JOURNAL", "CONSOLE"],
  },
];

/** Single files published at a fixed place. */
const SINGLE_FILES: readonly { source: string; target: string; editSource: string }[] = [
  {
    source: "docs/errors.md",
    target: "reference/errors.md",
    // errors.md is itself generated from the error definitions; edit those.
    editSource: "packages/mongoshield/src/errors.ts",
  },
  {
    // Results of bench/compare.ts; the numbers come from bench/results/*.json.
    source: "docs/benchmarks.md",
    target: "compare/benchmarks.md",
    editSource: "docs/benchmarks.md",
  },
];

/** A Markdown file that will be published, keyed by its repository path. */
interface PublishedDoc {
  readonly sourcePath: string;
  readonly targetFile: string;
  /** Root-relative URL on the site, e.g. `/guides/atlas/`. */
  readonly url: string;
  readonly editSource: string;
  readonly sidebarOrder?: number;
}

function main(): void {
  const docs = collectDocs();
  const urlBySource = new Map(docs.map((doc) => [doc.sourcePath, doc.url]));

  for (const collection of COLLECTIONS) resetDirectory(join(CONTENT_DIR, collection.targetDir));

  for (const doc of docs) {
    const markdown = readFileSync(join(REPO_ROOT, doc.sourcePath), "utf8");
    writePage(join(CONTENT_DIR, doc.targetFile), toSitePage(doc, markdown, urlBySource));
  }
  process.stdout.write(`sync-docs: ${docs.length} pages from docs/\n`);
}

/** Lists every file to publish, with its URL, so links can be resolved before writing. */
function collectDocs(): PublishedDoc[] {
  const docs: PublishedDoc[] = [];

  for (const collection of COLLECTIONS) {
    const names = readdirSync(join(REPO_ROOT, collection.sourceDir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"))
      .sort();

    for (const name of names) {
      const slug = name.toLowerCase();
      const listed = collection.order.indexOf(name);
      const sourcePath = `${collection.sourceDir}/${name}.md`;
      docs.push({
        sourcePath,
        targetFile: `${collection.targetDir}/${slug}.md`,
        url: `/${collection.targetDir}/${slug}/`,
        editSource: sourcePath,
        // Unlisted files sort after listed ones (Starlight then orders ties by name).
        sidebarOrder: listed === -1 ? collection.order.length + 1 : listed + 1,
      });
    }
  }

  for (const file of SINGLE_FILES) {
    if (!existsSync(join(REPO_ROOT, file.source))) continue;
    docs.push({
      sourcePath: file.source,
      targetFile: file.target,
      url: `/${file.target.replace(/\.md$/, "")}/`,
      editSource: file.editSource,
    });
  }
  return docs;
}

/** Turns one source file into a Starlight page. */
function toSitePage(
  doc: PublishedDoc,
  markdown: string,
  urlBySource: ReadonlyMap<string, string>,
): string {
  const { title, body } = splitTitle(markdown, doc.sourcePath);
  const frontmatter = renderFrontmatter({
    title,
    description: firstParagraph(body),
    editUrl: githubEditUrl(doc.editSource),
    sidebarOrder: doc.sidebarOrder,
  });
  const notice = generatedNotice(doc.sourcePath, "sync-docs.ts");
  return frontmatter + notice + rewriteLinks(body, doc.sourcePath, urlBySource);
}

/** Takes the first `# Heading` as the title and removes it from the body. */
function splitTitle(markdown: string, sourcePath: string): { title: string; body: string } {
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => line.startsWith("# "));
  if (index === -1) throw new Error(`${sourcePath} has no "# Title" heading`);

  const title = (lines[index] ?? "").slice(2).trim();
  const body = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n").trimStart();
  return { title, body };
}

/**
 * The first prose paragraph, as plain text, for the page's meta description.
 * Skips HTML comments, "Status: …" lines, code, tables and lists.
 */
function firstParagraph(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text === "" || /^(<!--|Status:|```|~~~|\||[-*>#]|\d+\.)/.test(text)) continue;
    const plain = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ");
    return plain.length > 300 ? `${plain.slice(0, 297).trimEnd()}…` : plain;
  }
  return undefined;
}

/**
 * Rewrites relative links outside fenced code blocks: inline links `[text](target)`
 * and reference definitions `[id]: target`.
 */
function rewriteLinks(
  body: string,
  sourcePath: string,
  urlBySource: ReadonlyMap<string, string>,
): string {
  let inFence = false;
  const rewrite = (target: string): string => resolveLink(target, sourcePath, urlBySource);

  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const definition = /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
      if (definition) return `${definition[1]}${rewrite(definition[2] ?? "")}${definition[3]}`;
      return line.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_match, target: string, title) => {
        return `](${rewrite(target)}${title})`;
      });
    })
    .join("\n");
}

/** Where a link in `sourcePath` should point on the site. */
function resolveLink(
  target: string,
  sourcePath: string,
  urlBySource: ReadonlyMap<string, string>,
): string {
  // Absolute URLs, mail links and same-page anchors need no change.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) {
    return target;
  }

  const hashIndex = target.indexOf("#");
  const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);

  const absolute = resolve(REPO_ROOT, dirname(sourcePath), decodeURIComponent(path));
  const repoPath = relative(REPO_ROOT, absolute).split("\\").join(posix.sep);
  if (repoPath.startsWith("..")) {
    console.warn(`sync-docs: ${sourcePath}: link outside the repository left as is: ${target}`);
    return target;
  }

  const siteUrl = urlBySource.get(repoPath);
  if (siteUrl) return `${siteUrl}${anchor}`;

  if (!existsSync(absolute)) {
    console.warn(`sync-docs: ${sourcePath}: broken link to ${repoPath}`);
  }
  const kind = existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob";
  return `${githubViewUrl(repoPath, kind)}${anchor}`;
}

main();
