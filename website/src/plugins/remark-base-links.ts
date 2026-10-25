/**
 * A remark plugin that adds the site's base path to root-relative links.
 *
 * Pages link to each other as `/guides/atlas/` (the synced docs are rewritten to
 * this form by scripts/sync-docs.ts, and hand-written pages use it too). On GitHub
 * Pages the site lives under `/mongoshield/`, so each such link becomes
 * `/mongoshield/guides/atlas/`. Links that already start with the base, external
 * links, protocol-relative links (`//host`) and anchors are left alone.
 */

/** The few mdast fields this plugin reads; avoids a dependency on @types/mdast. */
interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
}

/** Options: `base` as in astro.config (`/mongoshield`, or `/` for a root site). */
export interface RemarkBaseLinksOptions {
  readonly base: string;
}

/** Returns the remark transformer. */
export function remarkBaseLinks(options: RemarkBaseLinksOptions) {
  // "/mongoshield/" → "/mongoshield"; "/" → "" (nothing to add).
  const prefix = options.base.replace(/\/+$/, "");

  const visit = (node: MarkdownNode): void => {
    // `link` is [text](url); `definition` is a reference-style `[id]: url`.
    if ((node.type === "link" || node.type === "definition") && node.url !== undefined) {
      node.url = withBase(node.url, prefix);
    }
    for (const child of node.children ?? []) visit(child);
  };

  return (tree: MarkdownNode): void => visit(tree);
}

/** Adds `prefix` to a root-relative URL that does not have it yet. */
function withBase(url: string, prefix: string): string {
  if (prefix === "" || !url.startsWith("/") || url.startsWith("//")) return url;
  if (url === prefix || url.startsWith(`${prefix}/`)) return url;
  return `${prefix}${url}`;
}
