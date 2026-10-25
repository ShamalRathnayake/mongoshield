/**
 * Field-level differences between two versions of one document, for the restore
 * preview's side-by-side view (`POST /api/restore/preview/:id/document`), and hiding
 * values that look like secrets.
 *
 * Both versions are compared as canonical Extended JSON, so BSON types count: an Int32
 * 1 and a Double 1 differ, as they do for the library's `diff` (which compares the
 * exact BSON bytes). Values are shown as relaxed Extended JSON, the format the
 * document browser uses.
 *
 *   both objects          → compared field by field (dotted paths: `address.city`)
 *   both arrays           → compared element by element (`tags.2`)
 *   anything else         → one value; it differs when its canonical form differs
 *
 * Changes are named from the target's point of view: `added` is a field only the
 * backed-up version has (restoring it adds the field), `removed` one only the target
 * has, `changed` one both have with different values.
 *
 * Pure functions, unit-tested in preview-diff.test.ts.
 */

import { BSON, type Document } from "mongodb";
import type { PreviewDocumentDiff } from "../shared/api.ts";

/** Differing fields listed per document at most; the rest is summarized as `truncated`. */
export const MAX_FIELD_CHANGES = 200;

/** Longest value shown in the field list; longer values are cut (the documents stay whole). */
export const MAX_VALUE_CHARACTERS = 1_000;

/** What a redacted value is shown as. */
export const REDACTED = "***";

/**
 * Field names whose values are hidden: passwords, password hashes, tokens, API and
 * private keys, secrets and credentials. Deliberately broad (`passwordHash`,
 * `refreshToken`, `stripeSecretKey` all match): showing a secret of the target in a
 * browser is worse than hiding a harmless field. The change itself is still reported.
 */
const SECRET_FIELD = /password|passwd|secret|token|api_?key|private_?key|credential/i;

/** One differing field (see `PreviewDocumentDiff.fields`). */
export type FieldChange = PreviewDocumentDiff["fields"][number];

/** A JSON value as `BSON.EJSON.serialize` produces it. */
type Tree = unknown;

/** True when a field's value should be hidden (see {@link SECRET_FIELD}). */
export function looksSecret(field: string): boolean {
  return SECRET_FIELD.test(field);
}

/**
 * The fields that differ between the backed-up and the target version of a document.
 * Either may be missing (a document only on one side): then every field of the other
 * one is listed.
 */
export function diffDocumentFields(
  backup: Document | undefined,
  live: Document | undefined,
): { readonly fields: readonly FieldChange[]; readonly truncated: boolean } {
  const collector = new ChangeCollector();
  walk(collector, [], sidesOf(backup), sidesOf(live), false);
  return { fields: collector.changes, truncated: collector.truncated };
}

/**
 * A document as relaxed Extended JSON with the values of secret-looking fields
 * replaced by {@link REDACTED}.
 */
export function redactedJson(document: Document): string {
  return JSON.stringify(redactTree(BSON.EJSON.serialize(document, { relaxed: true }), false));
}

// ---------------------------------------------------------------------------
// Walking both versions
// ---------------------------------------------------------------------------

/** One version of a value in both forms: canonical (for comparing) and relaxed (for showing). */
interface Sides {
  readonly canonical: Tree;
  readonly relaxed: Tree;
}

function sidesOf(document: Document | undefined): Sides | undefined {
  if (document === undefined) return undefined;
  return {
    canonical: BSON.EJSON.serialize(document, { relaxed: false }),
    relaxed: BSON.EJSON.serialize(document, { relaxed: true }),
  };
}

/** Collects changes up to {@link MAX_FIELD_CHANGES}. */
class ChangeCollector {
  readonly changes: FieldChange[] = [];
  truncated = false;

  add(change: FieldChange): void {
    if (this.changes.length < MAX_FIELD_CHANGES) this.changes.push(change);
    else this.truncated = true;
  }
}

/** Compares one value of both versions at `path`; `secret` hides the values below it. */
function walk(
  collector: ChangeCollector,
  path: readonly string[],
  backup: Sides | undefined,
  live: Sides | undefined,
  secret: boolean,
): void {
  if (backup === undefined && live === undefined) return;
  const backupChildren = backup === undefined ? undefined : childrenOf(backup);
  const liveChildren = live === undefined ? undefined : childrenOf(live);

  // Both containers of the same kind: compare child by child.
  if (
    backupChildren !== undefined &&
    liveChildren !== undefined &&
    backupChildren.kind === liveChildren.kind
  ) {
    const keys = [...new Set([...backupChildren.entries.keys(), ...liveChildren.entries.keys()])];
    for (const key of keys) {
      walk(
        collector,
        [...path, key],
        backupChildren.entries.get(key),
        liveChildren.entries.get(key),
        secret || (backupChildren.kind === "object" && looksSecret(key)),
      );
    }
    return;
  }

  // The whole document is on one side only: list its top-level fields one by one.
  if (path.length === 0) {
    const present = backupChildren ?? liveChildren;
    for (const [key, child] of present?.entries ?? []) {
      walk(
        collector,
        [key],
        backup === undefined ? undefined : child,
        live === undefined ? undefined : child,
        looksSecret(key),
      );
    }
    return;
  }

  if (backup !== undefined && live !== undefined && sameValue(backup, live)) return;
  const redacted = secret;
  collector.add({
    path: path.join("."),
    change: backup === undefined ? "removed" : live === undefined ? "added" : "changed",
    ...(backup === undefined ? {} : { backup: shown(backup, redacted) }),
    ...(live === undefined ? {} : { live: shown(live, redacted) }),
    ...(redacted ? { redacted: true } : {}),
  });
}

/**
 * The children of an object or array, by field name or index, in both forms; or
 * `undefined` for a single value. Extended JSON type wrappers (`{"$oid": …}`,
 * `{"$numberInt": …}`) are single values, not objects.
 */
function childrenOf(
  value: Sides,
): { readonly kind: "object" | "array"; readonly entries: Map<string, Sides> } | undefined {
  const { canonical, relaxed } = value;
  if (Array.isArray(canonical) && Array.isArray(relaxed)) {
    const entries = new Map<string, Sides>();
    canonical.forEach((element: unknown, index) => {
      entries.set(String(index), { canonical: element, relaxed: relaxed[index] });
    });
    return { kind: "array", entries };
  }
  if (!isPlainObject(canonical) || !isPlainObject(relaxed) || isTypeWrapper(canonical)) {
    return undefined;
  }
  const entries = new Map<string, Sides>();
  for (const [key, child] of Object.entries(canonical)) {
    entries.set(key, { canonical: child, relaxed: relaxed[key] });
  }
  return { kind: "object", entries };
}

function isPlainObject(value: Tree): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{"$oid": …}`, `{"$date": …}`, `{"$binary": …}`: an object whose keys start with `$`. */
function isTypeWrapper(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

function sameValue(backup: Sides, live: Sides): boolean {
  return JSON.stringify(backup.canonical) === JSON.stringify(live.canonical);
}

/** A value for the field list: relaxed EJSON, cut when long, or hidden. */
function shown(value: Sides, redacted: boolean): string {
  if (redacted) return JSON.stringify(REDACTED);
  const text = JSON.stringify(value.relaxed) ?? "null";
  return text.length > MAX_VALUE_CHARACTERS ? `${text.slice(0, MAX_VALUE_CHARACTERS)}…` : text;
}

/** A relaxed EJSON tree with the values of secret-looking fields replaced, at any depth. */
function redactTree(value: Tree, secret: boolean): Tree {
  if (secret) return REDACTED;
  if (Array.isArray(value)) return value.map((element: unknown) => redactTree(element, false));
  if (!isPlainObject(value) || isTypeWrapper(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = redactTree(child, looksSecret(key));
  }
  return redacted;
}
