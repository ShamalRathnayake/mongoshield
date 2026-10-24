/**
 * The MongoShield documentation site: Astro + Starlight.
 *
 * Content comes from three places (see scripts/):
 *   - hand-written pages in src/content/docs (getting started, concepts, compare, …);
 *   - docs/guides, docs/specs and docs/errors.md, copied in by scripts/sync-docs.ts;
 *   - the CLI and config references, generated from the package's source.
 *
 * The site is served from GitHub Pages under /mongoshield/ by default. The deploy
 * workflow passes the real origin and base path (DOCS_SITE, DOCS_BASE) so a custom
 * domain needs no code change.
 */

import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { remarkBaseLinks } from "./src/plugins/remark-base-links.ts";

const site = process.env.DOCS_SITE || "https://shamalrathnayake.github.io";
// An empty DOCS_BASE is meaningful: the site is served from the root of its domain.
const base = process.env.DOCS_BASE ?? "/mongoshield";
const repository = "https://github.com/ShamalRathnayake/mongoshield";

export default defineConfig({
  site,
  base: base === "" ? "/" : base,
  // Every page is a directory (`/guides/atlas/`), which is what GitHub Pages serves best.
  trailingSlash: "always",
  markdown: {
    // Docs link to each other with root-relative URLs (`/specs/format/`); add the base path.
    // Astro 7's default Markdown processor takes no remark plugins, so use the unified one.
    // SmartyPants is off: it turns `--flag` in prose into an em dash and JSON quotes
    // into curly quotes, which breaks copy-pasted commands.
    processor: unified({ remarkPlugins: [[remarkBaseLinks, { base }]], smartypants: false }),
  },
  integrations: [
    starlight({
      title: "MongoShield",
      description:
        "Back up, restore and copy MongoDB from Node.js, without mongodump. Backups stay readable with standard tools.",
      logo: { src: "./src/assets/logo.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repository }],
      // Hand-written pages are edited here; synced and generated pages set `editUrl`
      // in their frontmatter to point at their real source.
      editLink: { baseUrl: `${repository}/edit/main/website/` },
      lastUpdated: false,
      customCss: ["./src/styles/custom.css"],
      components: {
        // Adds the "not affiliated with MongoDB, Inc." line under every page.
        Footer: "./src/components/Footer.astro",
      },
      sidebar: [
        {
          label: "Getting started",
          items: [
            "getting-started/introduction",
            "getting-started/install",
            "getting-started/quickstart-cli",
            "getting-started/quickstart-library",
          ],
        },
        // Every file in docs/guides, ordered by scripts/sync-docs.ts.
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        {
          label: "Concepts",
          items: [
            "concepts/storage",
            "concepts/consistency",
            "concepts/encryption",
            "concepts/retention",
            "concepts/point-in-time-recovery",
          ],
        },
        {
          label: "Reference",
          items: [
            {
              label: "CLI",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/cli" } }],
            },
            "reference/config",
            "reference/errors",
            "reference/library",
          ],
        },
        { label: "Specs", collapsed: true, items: [{ autogenerate: { directory: "specs" } }] },
        {
          label: "Compare",
          items: ["compare/mongodump", "compare/atlas", "compare/percona"],
        },
        "limitations",
      ],
    }),
  ],
});
