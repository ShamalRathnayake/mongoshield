/**
 * The version-specific checks of an upgrade rehearsal, run on the restored
 * (temporary) databases on the newer server, after the drill's own checks
 * (counts, indexes, views exist, sampled documents):
 *
 *   validate     `validate` on every restored collection and time series: the new
 *                server's own consistency check of the data and index files it built
 *   view         every restored view is queried (its first VIEW_SAMPLE documents):
 *                a view whose pipeline the new server no longer accepts, or whose
 *                server-side JavaScript fails, errors here, not at creation
 *   validator    every validator is evaluated as a query: documents that do not
 *                satisfy it on the new server would be rejected on their next update
 *   undefined    only when the upgrade crosses 8.0: documents holding the deprecated
 *                `undefined` type in a field the validator compares with `null`, which
 *                8.0 no longer treats as null (see the `null-matches-undefined` rule)
 *
 * Every check is recorded with its outcome, passed ones too, so the report shows
 * what was proven, not only what failed.
 */

import type { Db, Document, MongoClient } from "mongodb";
import { throwIfAborted } from "../errors.ts";
import { isPlainDocument, valueInStoredOrder } from "../format/field-order.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { RestorePlanEntry } from "../types.ts";
import { messageOf } from "./drill-checks.ts";
import type { BackedUpCollection } from "./upgrade-compat.ts";
import { nullEqualityPaths } from "./upgrade-compat-scan.ts";

/** Documents read from each view to prove it runs (enough to execute every stage). */
export const VIEW_SAMPLE = 100;

/** Validation errors quoted per collection; `validate` can return thousands. */
const MAX_VALIDATE_ERRORS = 3;

/**
 * A server error as one line: JavaScript errors come back with the script's stack
 * (`… is not a function :\n@:1:29`), which would break table rows and log lines.
 */
function oneLine(error: unknown): string {
  return messageOf(error).replace(/\s+/g, " ").trim();
}

/** `1 index`, `2 indexes`. */
function quantity(value: unknown, singular: string, pluralForm: string): string {
  return `${String(value)} ${value === 1 ? singular : pluralForm}`;
}

/** The kinds of live check (see the file header). */
export type UpgradeCheckKind = "validate" | "view" | "validator" | "undefined";

/** The outcome of one live check. */
export interface UpgradeCheck {
  /** The namespace in the backup, e.g. `app.users`. */
  readonly ns: string;
  readonly check: UpgradeCheckKind;
  /** `passed`, or what the failure means: a `problem` fails the rehearsal, a `warning` does not. */
  readonly outcome: "passed" | "problem" | "warning";
  /** What was found, one sentence. */
  readonly message: string;
}

/** What the live checks need. */
export interface LiveCheckInput {
  readonly client: MongoClient;
  /** The restore plan (backup namespace → temporary namespace). */
  readonly entries: readonly RestorePlanEntry[];
  /** The backed-up definitions, by backup namespace (from the compatibility input). */
  readonly collections: ReadonlyMap<string, BackedUpCollection>;
  /** True when the upgrade crosses 8.0 and the undefined check applies. */
  readonly checkUndefined: boolean;
  readonly signal?: AbortSignal | undefined;
}

/** Runs every live check, namespace by namespace, in restore plan order. */
export async function runLiveChecks(input: LiveCheckInput): Promise<UpgradeCheck[]> {
  const checks: UpgradeCheck[] = [];
  for (const entry of input.entries) {
    throwIfAborted(input.signal);
    const target = splitNamespace(entry.to);
    const db = input.client.db(target.database);
    if (entry.type === "view") {
      checks.push(await queryView(db, target.collection, entry.from));
      continue;
    }
    checks.push(await validateCollection(db, target.collection, entry.from));
    const validator = validatorOf(input.collections.get(entry.from));
    if (validator === undefined) continue;
    checks.push(await evaluateValidator(db, target.collection, entry.from, validator));
    if (input.checkUndefined) {
      checks.push(...(await countUndefined(db, target.collection, entry.from, validator)));
    }
  }
  return checks;
}

/** A backed-up collection's validator, if it has one. */
function validatorOf(collection: BackedUpCollection | undefined): Document | undefined {
  const validator: unknown = collection?.metadata.options.validator;
  return isPlainDocument(validator) ? validator : undefined;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * `validate` (not `full`: that also checks storage internals and takes an exclusive
 * lock; the default already reads every document and index entry).
 */
export async function validateCollection(db: Db, name: string, ns: string): Promise<UpgradeCheck> {
  let result: Document;
  try {
    result = await db.command({ validate: name });
  } catch (error) {
    return {
      ns,
      check: "validate",
      outcome: "warning",
      message: `could not run validate: ${oneLine(error)}`,
    };
  }
  if (result.valid !== true) {
    const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
    const quoted = errors.slice(0, MAX_VALIDATE_ERRORS).join("; ");
    return {
      ns,
      check: "validate",
      outcome: "problem",
      message: `validate found the restored collection invalid${quoted === "" ? "" : `: ${quoted}`}`,
    };
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  if (warnings.length > 0) {
    return {
      ns,
      check: "validate",
      outcome: "warning",
      message: `validate passed with warnings: ${warnings.join("; ")}`,
    };
  }
  const records =
    typeof result.nrecords === "number"
      ? `${quantity(result.nrecords, "record", "records")}, `
      : "";
  return {
    ns,
    check: "validate",
    outcome: "passed",
    message: `validate passed (${records}${quantity(result.nIndexes ?? "?", "index", "indexes")})`,
  };
}

/** Reads the first VIEW_SAMPLE documents of a view. */
export async function queryView(db: Db, name: string, ns: string): Promise<UpgradeCheck> {
  try {
    const documents = await db.collection(name).find({}, { limit: VIEW_SAMPLE }).toArray();
    return {
      ns,
      check: "view",
      outcome: "passed",
      message: `the view runs (${documents.length} documents read)`,
    };
  } catch (error) {
    return {
      ns,
      check: "view",
      outcome: "problem",
      message: `querying the view fails: ${oneLine(error)}`,
    };
  }
}

/**
 * Counts the documents that do not satisfy the validator. Not a problem by itself:
 * with `validationLevel: "moderate"`, or a validator added after the data, such
 * documents may already exist on the source. A validator the server cannot evaluate
 * at all is a problem.
 */
export async function evaluateValidator(
  db: Db,
  name: string,
  ns: string,
  validator: Document,
): Promise<UpgradeCheck> {
  let failing: number;
  try {
    // Stored field order: a validator may hold integer-like field names.
    failing = await db
      .collection(name)
      .countDocuments({ $nor: [valueInStoredOrder(validator) as Document] });
  } catch (error) {
    return {
      ns,
      check: "validator",
      outcome: "problem",
      message: `the validator cannot be evaluated: ${oneLine(error)}`,
    };
  }
  if (failing === 0) {
    return {
      ns,
      check: "validator",
      outcome: "passed",
      message: "every document satisfies the validator",
    };
  }
  return {
    ns,
    check: "validator",
    outcome: "warning",
    message: `${failing} document${failing === 1 ? " does" : "s do"} not satisfy the validator on this server: updates to ${failing === 1 ? "it" : "them"} will be rejected (check whether that is already so on the source)`,
  };
}

/**
 * For each field the validator compares with null: how many documents hold
 * `undefined` there, which MongoDB 8.0 no longer matches as null.
 */
export async function countUndefined(
  db: Db,
  name: string,
  ns: string,
  validator: Document,
): Promise<UpgradeCheck[]> {
  const checks: UpgradeCheck[] = [];
  for (const path of nullEqualityPaths(validator)) {
    let count: number;
    try {
      count = await db.collection(name).countDocuments({ [path]: { $type: "undefined" } });
    } catch (error) {
      checks.push({
        ns,
        check: "undefined",
        outcome: "warning",
        message: `could not count undefined values in "${path}": ${oneLine(error)}`,
      });
      continue;
    }
    checks.push(
      count === 0
        ? {
            ns,
            check: "undefined",
            outcome: "passed",
            message: `no document holds undefined in "${path}"`,
          }
        : {
            ns,
            check: "undefined",
            outcome: "problem",
            message: `${count} document${count === 1 ? " holds" : "s hold"} undefined in "${path}", which the validator compares with null: from 8.0 on that no longer matches, so updates to ${count === 1 ? "it" : "them"} fail validation. Replace undefined with null first.`,
          },
    );
  }
  return checks;
}
