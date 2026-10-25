/**
 * Generates the config file reference (src/content/docs/reference/config.md) from
 * the zod schema in packages/mongoshield/src/config/schema.ts.
 *
 * Two sources are combined:
 *
 * 1. The *shape* (keys, types, allowed values, limits, required keys) comes from zod's
 *    JSON Schema export (`ConfigSchema.toJSONSchema()`, the method form of
 *    `z.toJSONSchema`), so the table always matches what validation accepts.
 * 2. The *descriptions* come from the JSDoc comments above each key in schema.ts.
 *    JSON Schema only carries `.describe()` texts, and the schema documents its keys
 *    with comments, so they are read from the source text (see `readKeyComments`).
 *
 * Run with `node --experimental-transform-types scripts/gen-config-reference.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_DIR,
  codeCell,
  generatedNotice,
  githubEditUrl,
  REPO_ROOT,
  renderFrontmatter,
  tableCell,
  writePage,
} from "./lib.ts";

const SCHEMA_SOURCE = "packages/mongoshield/src/config/schema.ts";
const SCRIPT = "gen-config-reference.ts";

/** The parts of a JSON Schema this page reads. */
interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly additionalProperties?: JsonSchema | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minItems?: number;
}

/** A zod schema, as far as this script needs it. */
interface ZodSchemaLike {
  toJSONSchema(params: { io: "input"; unrepresentable: "any" }): JsonSchema;
}

const { ConfigSchema } = (await import(`../../${SCHEMA_SOURCE}`)) as {
  ConfigSchema: ZodSchemaLike;
};

/** One row of the reference table. */
interface Row {
  readonly path: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

function main(): void {
  // `io: "input"` describes what users write (defaults are optional);
  // `unrepresentable: "any"` turns the storage-adapter object (a z.custom) into `{}`.
  const schema = ConfigSchema.toJSONSchema({ io: "input", unrepresentable: "any" });
  const comments = readKeyComments(readFileSync(join(REPO_ROOT, SCHEMA_SOURCE), "utf8"));

  const sections: string[] = [];
  const topRequired = new Set(schema.required ?? []);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const rows: Row[] = [];
    collectRows(key, child, topRequired.has(key), comments, rows);
    sections.push(renderSection(key, rows, comments));
  }

  const page = [
    renderFrontmatter({
      title: "Config file",
      description: "Every key of mongoshield.config.ts, generated from the validation schema.",
      editUrl: githubEditUrl(SCHEMA_SOURCE),
    }),
    generatedNotice(SCHEMA_SOURCE, SCRIPT),
    INTRO,
    ...sections,
  ].join("\n");
  writePage(join(CONTENT_DIR, "reference", "config.md"), page);
  process.stdout.write(
    `gen-config-reference: ${Object.keys(schema.properties ?? {}).length} sections\n`,
  );
}

const INTRO = `The CLI reads \`mongoshield.config.ts\` (or \`.js\`, \`.mjs\`) from the current
directory, or the file given with \`--config\`. Write it with \`defineConfig\` for type checking:

\`\`\`ts
// mongoshield.config.ts
import { defineConfig } from "mongoshield";

export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "s3://acme-backups/prod",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  decryption: { identityFiles: ["./mongoshield-identity.txt"] },
  backup: { exclude: ["*.sessions"] },
  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
});
\`\`\`

Any value may be \`undefined\` in the file (an unset environment variable, say). Validation
runs after \`MONGOSHIELD_*\` environment variables and command-line flags are merged in, so
an error names what is actually missing. Unknown keys are rejected, which catches typos.

In the tables, \`a.b\` is a key inside \`a\`, and \`a[].b\` a key of each object in the array \`a\`.
`;

/** Walks a schema node and adds a row for it and for everything inside it. */
function collectRows(
  path: string,
  node: JsonSchema,
  required: boolean,
  comments: ReadonlyMap<string, string>,
  rows: Row[],
): void {
  rows.push({
    path,
    type: describeType(node),
    required,
    description: describeKey(path, node, comments),
  });

  // Objects: one row per key.
  const requiredKeys = new Set(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    collectRows(`${path}.${key}`, child, requiredKeys.has(key), comments, rows);
  }

  // Arrays of objects: the keys of each element, as `path[].key`.
  const element = node.items;
  if (element?.properties) {
    const elementRequired = new Set(element.required ?? []);
    for (const [key, child] of Object.entries(element.properties)) {
      collectRows(`${path}[].${key}`, child, elementRequired.has(key), comments, rows);
    }
  }
}

/** A short, readable type: `"zstd" \| "gzip"`, `integer, 1–64`, `string[] (at least 1)`. */
function describeType(node: JsonSchema): string {
  if (node.anyOf) {
    // The only union in the schema is `storage`: a URL string or an adapter object.
    return node.anyOf
      .map((option) => (option.type ? describeType(option) : "StorageAdapter"))
      .join(" or ");
  }
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");

  switch (node.type) {
    case "array": {
      const element = node.items ? describeType(node.items) : "unknown";
      const simple = /^[a-z]+$/.test(element);
      const base = simple ? `${element}[]` : `array of ${element}`;
      return node.minItems ? `${base} (at least ${node.minItems})` : base;
    }
    case "object":
      // Records (labels) have no fixed keys, only a type for their values.
      if (!node.properties && typeof node.additionalProperties === "object") {
        return `object of ${describeType(node.additionalProperties)}`;
      }
      return "object";
    case "integer":
    case "number":
      return withRange(node.type, node);
    case "string":
      return node.format === "uri" ? "URL" : "string";
    default:
      return node.type ?? "any";
  }
}

/** `integer, 1–64`, `number, > 0`, `integer, ≥ 0`. Huge safe-integer maxima are left out. */
function withRange(type: string, node: JsonSchema): string {
  const max = node.maximum !== undefined && node.maximum < 2 ** 31 ? node.maximum : undefined;
  if (node.minimum !== undefined && max !== undefined) return `${type}, ${node.minimum}–${max}`;
  const bounds: string[] = [];
  if (node.minimum !== undefined) bounds.push(`≥ ${node.minimum}`);
  if (node.exclusiveMinimum !== undefined) bounds.push(`> ${node.exclusiveMinimum}`);
  if (max !== undefined) bounds.push(`≤ ${max}`);
  return bounds.length > 0 ? `${type}, ${bounds.join(", ")}` : type;
}

/**
 * Descriptions for keys that schema.ts does not document with a comment yet.
 * A JSDoc comment in schema.ts always wins; once every key has one, this can go.
 */
const FALLBACK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "encryption.kms[].provider": "Which cloud KMS: AWS KMS, Google Cloud KMS or Azure Key Vault.",
  "decryption.passphrase": "The passphrase of passphrase-encrypted backups.",
  "backup.include": "Namespace patterns to back up, e.g. `app.*`. Default: everything.",
  "backup.exclude": "Namespace patterns to leave out, e.g. `*.sessions`.",
  "backup.consistency":
    "Point-in-time consistency across collections. Defaults to `auto` (see Concepts → Consistency).",
  "backup.parallelism": "Collections (and parts) backed up at the same time. Defaults to 4.",
  "backup.labels": 'Labels attached to every backup, e.g. `{ env: "prod" }`.',
  "retention.daily": "Keep the newest backup from each of the last N days that have one (UTC).",
  "retention.weekly": "Keep the newest backup from each of the last N ISO weeks that have one.",
  "retention.monthly": "Keep the newest backup from each of the last N months that have one.",
  "retention.yearly": "Keep the newest backup from each of the last N years that have one.",
  "notify[].type": "`webhook` (a JSON POST), `slack` or `discord` (incoming webhooks).",
  "notify[].url": "The webhook URL. Treat it as a secret.",
};

/** The description: the JSDoc comment, else the zod `.describe()` text, else a fallback. */
function describeKey(
  path: string,
  node: JsonSchema,
  comments: ReadonlyMap<string, string>,
): string {
  return comments.get(path) ?? node.description ?? FALLBACK_DESCRIPTIONS[path] ?? "";
}

/** One `## key` section with its table. */
function renderSection(
  key: string,
  rows: readonly Row[],
  comments: ReadonlyMap<string, string>,
): string {
  const [top, ...nested] = rows;
  const lines = [`## \`${key}\``, ""];
  if (top) {
    lines.push(`${tableCell(comments.get(key) ?? top.description)}`, "");
    lines.push(`Type: ${codeCell(top.type)}${top.required ? " (required)" : ""}`, "");
  }
  if (nested.length > 0) {
    lines.push("| Key | Type | Description |", "|---|---|---|");
    for (const row of nested) {
      const required = row.required ? " **required**" : "";
      lines.push(
        `| ${codeCell(row.path)} | ${codeCell(row.type)}${required} | ${tableCell(row.description)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Reads the JSDoc comment above each key of the schema, keyed by its path in the
 * config (`schedule.cron`, `notify[].type`, `encryption.kms[].provider`).
 *
 * The schema file is formatted by Biome, so nesting is visible from indentation:
 * a key line `name: …` belongs to the nearest less-indented key above it. Schemas
 * declared separately (`export const RetentionConfigSchema = z.object(…)`) are read
 * the same way and then attached where a key refers to them
 * (`retention: RetentionConfigSchema.optional()`).
 */
function readKeyComments(source: string): Map<string, string> {
  /** Comments of each separately declared schema, by its relative key path. */
  const bySchema = new Map<string, Map<string, string>>();
  /** Keys whose children come from another schema: `notify` → `NotifyTargetSchema` (+ `[]`). */
  const references: { path: string; schema: string; root: string }[] = [];

  let currentSchema: string | undefined;
  let stack: { indent: number; key: string }[] = [];
  let pendingComment: string[] = [];
  let inComment = false;

  for (const line of source.split("\n")) {
    const declaration = /^(?:export )?const (\w+Schema) = /.exec(line);
    if (declaration?.[1]) {
      currentSchema = declaration[1];
      bySchema.set(currentSchema, new Map());
      stack = [];
      pendingComment = [];
      continue;
    }
    if (!currentSchema) continue;

    // Collect `/** … */` blocks (single- or multi-line).
    const trimmed = line.trim();
    if (trimmed.startsWith("/**")) {
      inComment = !trimmed.endsWith("*/");
      pendingComment = [stripCommentSyntax(trimmed)];
      continue;
    }
    if (inComment) {
      inComment = !trimmed.endsWith("*/");
      pendingComment.push(stripCommentSyntax(trimmed));
      continue;
    }

    const key = /^(\s*)(\w+): /.exec(line);
    if (!key?.[2] || trimmed.startsWith("message:")) {
      if (trimmed !== "" && !trimmed.startsWith("//")) pendingComment = [];
      continue;
    }

    const indent = key[1]?.length ?? 0;
    stack = stack.filter((entry) => entry.indent < indent);
    // `z.array(…)` of objects: the children of this key are array elements.
    const parentPath = stack.map((entry) => entry.key).join(".");
    const path = parentPath ? `${parentPath}.${key[2]}` : key[2];
    const isArray = /z\s*\.array\(/.test(line) || /^\s*\.array\(/.test(line);
    stack.push({ indent, key: isArray ? `${key[2]}[]` : key[2] });

    const comment = pendingComment.join(" ").replace(/\s+/g, " ").trim();
    if (comment) bySchema.get(currentSchema)?.set(path, comment);
    pendingComment = [];

    const referenced = /\b(\w+Schema)\b/.exec(line);
    if (referenced?.[1] && referenced[1] !== currentSchema) {
      references.push({
        path: isArray ? `${path}[]` : path,
        schema: referenced[1],
        root: currentSchema,
      });
    }
  }

  // Flatten ConfigSchema, attaching referenced schemas under the key that uses them.
  const result = new Map(bySchema.get("ConfigSchema") ?? []);
  const attach = (prefix: string, schemaName: string): void => {
    for (const [path, comment] of bySchema.get(schemaName) ?? []) {
      result.set(`${prefix}.${path}`, comment);
    }
    for (const reference of references.filter((entry) => entry.root === schemaName)) {
      attach(`${prefix}.${reference.path}`, reference.schema);
    }
  };
  for (const reference of references.filter((entry) => entry.root === "ConfigSchema")) {
    attach(reference.path, reference.schema);
  }
  return result;
}

/** `/** Keep the N newest backups. *\/` → `Keep the N newest backups.` */
function stripCommentSyntax(line: string): string {
  return line
    .replace(/^\/\*\*\s?/, "")
    .replace(/\s?\*\/$/, "")
    .replace(/^\*\s?/, "")
    .trim();
}

main();
