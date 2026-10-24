/**
 * Upgrade compatibility analysis: what in a backup breaks, or behaves differently,
 * on a newer MongoDB release. Pure: it takes the backup's manifest version and its
 * metadata (collection options, indexes, validators, view pipelines, users, roles,
 * stored JavaScript) and returns findings; reading those from storage is
 * upgrade-inputs.ts's job, restoring and checking live is upgrade-rehearsal.ts's.
 *
 * Every rule comes from MongoDB's release notes ("Compatibility Changes in MongoDB
 * x.y") or, where the notes are silent, from the server's own validation code, and
 * cites its source. Only changes that can be decided from what a backup holds are
 * encoded: a removed server parameter, a changed `serverStatus` field or a driver
 * requirement says nothing about a backup and is left out on purpose.
 *
 * Two kinds of rule:
 *
 *   target     the change is a removal or a new restriction: anything that uses the
 *              feature fails on the target, whatever the source version was
 *              (a geoHaystack index cannot be created on 5.0 or later)
 *   crossing   the change is a different behaviour: it only matters when the upgrade
 *              crosses the release that introduced it (`{ f: null }` matches
 *              `undefined` before 8.0 and no longer does from 8.0 on)
 *
 * And two severities:
 *
 *   problem    will fail or lose data on the target: the restore (or an in-place
 *              upgrade) refuses it, documents expire, writes are blocked
 *   warning    works, but differently, or only under conditions the backup cannot
 *              show (FIPS mode, how a stored function is called): review it
 *
 * Sources, cited by URL in each rule. The 4.0–6.0 pages are end-of-life and
 * mongodb.com now redirects them, so they are cited from the documentation's own
 * repository (github.com/mongodb/docs), which keeps the exact published text.
 */

import type { Document } from "mongodb";
import { isPlainDocument } from "../format/field-order.ts";
import type { CollectionMetadata, CollectionType } from "../format/metadata.ts";
import { REJECTED_CREATE_OPTIONS } from "./restore-collections.ts";
import {
  bsonTypeOf,
  codeText,
  hasEqualityLookup,
  invalidRegexOptions,
  javaScriptSources,
  matchQueries,
  nullEqualityPaths,
  numberValue,
  operatorsUsed,
  regexOptionsIn,
  removedStaticFunctionCalls,
} from "./upgrade-compat-scan.ts";
import {
  compareVersions,
  formatVersion,
  isAtLeast,
  NEWEST_KNOWN_RELEASE,
  parseServerVersion,
  parseTargetVersion,
  releaseName,
  type ServerVersion,
  upgradePath,
} from "./upgrade-versions.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** The release notes and server code the rules cite. */
export const SOURCES = {
  compat40: "https://github.com/mongodb/docs/blob/v4.0/source/release-notes/4.0-compatibility.txt",
  compat50: "https://github.com/mongodb/docs/blob/v5.0/source/release-notes/5.0-compatibility.txt",
  compat60: "https://github.com/mongodb/docs/blob/v6.0/source/release-notes/6.0-compatibility.txt",
  compat70: "https://www.mongodb.com/docs/manual/release-notes/7.0-compatibility/",
  compat80: "https://www.mongodb.com/docs/manual/release-notes/8.0-compatibility/",
  upgrade80: "https://www.mongodb.com/docs/manual/release-notes/8.0-upgrade-replica-set/",
  /** The index specification fields and key values the server accepts (MongoDB 8.0.13). */
  indexValidation:
    "https://github.com/mongodb/mongo/blob/r8.0.13/src/mongo/db/catalog/index_key_validate.h",
  /** The fields of the `create` command (MongoDB 8.0.13). */
  createCommand: "https://github.com/mongodb/mongo/blob/r8.0.13/src/mongo/db/commands/create.idl",
  /** mongorestore's `--convertLegacyIndexes`, the same repair for the same old indexes. */
  convertLegacyIndexes:
    "https://www.mongodb.com/docs/database-tools/mongorestore/#std-option-mongorestore.--convertLegacyIndexes",
  regexOptions:
    "https://www.mongodb.com/docs/manual/reference/operator/query/regex/#mongodb-query-op.-options",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `problem`: fails or loses data on the target. `warning`: review it. */
export type CompatibilitySeverity = "problem" | "warning";

/** One thing the analysis found. */
export interface CompatibilityFinding {
  /** Stable rule id, e.g. `index-geohaystack` (see `COMPATIBILITY_RULES`). */
  readonly rule: string;
  readonly severity: CompatibilitySeverity;
  /** What it is about: a namespace (`app.users`), `users`, `roles` or `upgrade`. */
  readonly subject: string;
  /** What is wrong and what to do, in a sentence or two. */
  readonly message: string;
  /** The MongoDB release that made the change, e.g. `"5.0"`. */
  readonly since: string;
  /** Where the change is documented. */
  readonly reference: string;
}

/** One backed-up collection, view or time series, with its metadata file's contents. */
export interface BackedUpCollection {
  /** `db.collection`. */
  readonly ns: string;
  readonly type: CollectionType;
  readonly metadata: CollectionMetadata;
}

/** Stored JavaScript: the documents of one `<db>.system.js` collection. */
export interface StoredJavaScript {
  readonly ns: string;
  readonly documents: readonly Document[];
}

/** Everything the analysis looks at. */
export interface CompatibilityInput {
  /** The source's version as the manifest records it (`manifest.source.serverVersion`). */
  readonly sourceVersion: string;
  /** The release to upgrade to: `"8.0"` or `"8.0.13"`. */
  readonly targetVersion: string;
  readonly collections: readonly BackedUpCollection[];
  /** `admin.system.users` documents, for backups taken with users and roles. */
  readonly users?: readonly Document[];
  /** `admin.system.roles` documents, for backups taken with users and roles. */
  readonly roles?: readonly Document[];
  readonly storedJavaScript?: readonly StoredJavaScript[];
  /** Namespaces whose metadata could not be read, with the reason: not analysed. */
  readonly unreadable?: readonly { readonly ns: string; readonly reason: string }[];
}

/** The outcome of the analysis. */
export interface CompatibilityReport {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  /**
   * The releases an in-place upgrade of production steps through, ending with the
   * target (`["7.0", "8.0"]` from 6.0). Empty when the target is not newer.
   */
  readonly upgradePath: readonly string[];
  /** True when there are no problems (warnings allowed). */
  readonly ok: boolean;
  /** Problems first, then warnings; within each, in rule order. */
  readonly findings: readonly CompatibilityFinding[];
  /** How many rules applied to this source and target (the others were skipped). */
  readonly rulesChecked: number;
}

/** A finding as a rule reports it; the rule adds its id, severity and source. */
interface RuleHit {
  readonly subject: string;
  readonly message: string;
}

/** What every rule's check sees. */
interface RuleInput {
  readonly collections: readonly BackedUpCollection[];
  readonly users: readonly Document[];
  readonly roles: readonly Document[];
  readonly storedJavaScript: readonly StoredJavaScript[];
  /** Undefined when the backup does not record a usable version (imported dumps). */
  readonly source: ServerVersion | undefined;
  readonly target: ServerVersion;
}

/** One encoded compatibility change. */
export interface CompatibilityRule {
  readonly id: string;
  readonly severity: CompatibilitySeverity;
  /** The release that made the change. */
  readonly since: string;
  /** `target`: applies when the target is `since` or newer; `crossing`: only when the upgrade crosses `since`. */
  readonly applies: "target" | "crossing";
  readonly reference: string;
  /** One line for documentation and `--help`. */
  readonly summary: string;
  readonly check: (input: RuleInput) => Iterable<RuleHit>;
}

// ---------------------------------------------------------------------------
// Index rules
// ---------------------------------------------------------------------------

/**
 * Index key values the server accepts as an index type (`IndexNames` in the server:
 * src/mongo/db/index_names.cpp). `geoHaystack` has its own rule.
 */
const INDEX_PLUGINS = new Set([
  "2d",
  "2dsphere",
  "2dsphere_bucket",
  "text",
  "hashed",
  "columnstore",
  "queryable_encrypted_range",
]);

/**
 * Index specification fields the server accepts (`allowedFieldNames` in
 * index_key_validate.h, MongoDB 8.0.13), plus `clustered`, which restore handles
 * through the collection's `clusteredIndex` option. Anything else makes
 * `createIndexes` fail with "The field '…' is not valid for an index specification".
 */
export const INDEX_SPEC_FIELDS = new Set([
  "2dsphereIndexVersion",
  "_id",
  "background",
  "bits",
  "bucketSize",
  "clustered",
  "coarsestIndexedLevel",
  "collation",
  "columnstoreCompressor",
  "columnstoreProjection",
  "default_language",
  "dropDups",
  "expireAfterSeconds",
  "finestIndexedLevel",
  "hidden",
  "key",
  "language_override",
  "max",
  "min",
  "name",
  "ns",
  "originalSpec",
  "partialFilterExpression",
  "prepareUnique",
  "sparse",
  "storageEngine",
  "textIndexVersion",
  "unique",
  "v",
  "weights",
  "wildcardProjection",
]);

/** Calls `check` for every backed-up index; collects what it reports. */
function* eachIndex(
  input: RuleInput,
  check: (collection: BackedUpCollection, index: Document, name: string) => RuleHit | undefined,
): Iterable<RuleHit> {
  for (const collection of input.collections) {
    for (const index of collection.metadata.indexes) {
      const name = typeof index.name === "string" ? index.name : "(unnamed)";
      const hit = check(collection, index, name);
      if (hit !== undefined) yield hit;
    }
  }
}

/** The values of an index's key pattern (`{ a: 1, b: "text" }` → `[1, "text"]`). */
function keyValues(index: Document): unknown[] {
  return isPlainDocument(index.key) ? Object.values(index.key) : [];
}

/** True when the index has the given type (`"text"`, `"geoHaystack"`, …) in its key. */
function hasKeyType(index: Document, type: string): boolean {
  return keyValues(index).includes(type);
}

/**
 * Why a key value is not accepted for a new index, or undefined when it is. Mirrors
 * `validateKeyPattern` in index_key_validate.cpp: numbers must be non-zero and not
 * NaN, strings must name an index type, nothing else is allowed.
 */
export function invalidKeyValueReason(value: unknown): string | undefined {
  const number = numberValue(value);
  if (number !== undefined) {
    if (Number.isNaN(number)) return "NaN";
    if (number === 0) return "0";
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "") return "an empty string";
    if (value === "geoHaystack" || INDEX_PLUGINS.has(value)) return undefined;
    return `"${value}" (not an index type)`;
  }
  const type = bsonTypeOf(value) ?? (value === null ? "null" : typeof value);
  return `a value of type ${type}`;
}

const INDEX_RULES: readonly CompatibilityRule[] = [
  {
    id: "index-geohaystack",
    severity: "problem",
    since: "5.0",
    applies: "target",
    reference: SOURCES.compat50,
    summary: "geoHaystack indexes were removed",
    check: (input) =>
      eachIndex(input, (collection, index, name) =>
        hasKeyType(index, "geoHaystack")
          ? {
              subject: collection.ns,
              message: `index "${name}" is a geoHaystack index: MongoDB 5.0 removed them, the restore cannot create it, and setting the feature compatibility version to 5.0 in place deletes it. Replace it with a 2d index.`,
            }
          : undefined,
      ),
  },
  {
    id: "index-ttl-nan",
    severity: "problem",
    since: "5.0",
    applies: "target",
    reference: SOURCES.compat50,
    summary: "TTL indexes with expireAfterSeconds NaN expire documents immediately",
    check: (input) =>
      eachIndex(input, (collection, index, name) => {
        const seconds = numberValue(index.expireAfterSeconds);
        if (seconds === undefined || !Number.isNaN(seconds)) return undefined;
        return {
          subject: collection.ns,
          message: `TTL index "${name}" has expireAfterSeconds NaN: from 5.0 on, upgrades and restores treat it as 0, so documents may expire immediately (current servers refuse to create it). Set a real number with collMod first.`,
        };
      }),
  },
  {
    id: "index-weights-without-text",
    severity: "problem",
    since: "5.0",
    applies: "target",
    reference: SOURCES.compat50,
    summary: "the weights option is only allowed on text indexes",
    check: (input) =>
      eachIndex(input, (collection, index, name) =>
        index.weights !== undefined && !hasKeyType(index, "text")
          ? {
              subject: collection.ns,
              message: `index "${name}" has a weights option but is not a text index: from 5.0 on the server refuses it. Drop the option (recreate the index without it).`,
            }
          : undefined,
      ),
  },
  {
    id: "index-invalid-key",
    severity: "problem",
    since: "3.4",
    applies: "target",
    reference: SOURCES.indexValidation,
    summary: "legacy index key values (0, '', true, unknown types) cannot be recreated",
    check: (input) =>
      eachIndex(input, (collection, index, name) => {
        if (!isPlainDocument(index.key)) return undefined;
        for (const [field, value] of Object.entries(index.key)) {
          const reason = invalidKeyValueReason(value);
          if (reason === undefined) continue;
          return {
            subject: collection.ns,
            message: `index "${name}" has ${reason} as the key value of "${field}": old servers accepted that, current ones refuse to create such an index (only non-zero numbers and index types are allowed), so the restore fails. An in-place upgrade keeps it; recreate it with 1 or -1 anyway (mongorestore's --convertLegacyIndexes does the same).`,
          };
        }
        return undefined;
      }),
  },
  {
    id: "index-unknown-option",
    severity: "problem",
    since: "3.4",
    applies: "target",
    reference: SOURCES.indexValidation,
    summary: "index options the server does not know make createIndexes fail",
    check: (input) =>
      eachIndex(input, (collection, index, name) => {
        const unknown = Object.keys(index).filter((field) => !INDEX_SPEC_FIELDS.has(field));
        if (unknown.length === 0) return undefined;
        return {
          subject: collection.ns,
          message: `index "${name}" has option${unknown.length === 1 ? "" : "s"} ${unknown.map((field) => `"${field}"`).join(", ")} that the server does not accept ("not valid for an index specification"), so the restore fails. Recreate the index without ${unknown.length === 1 ? "it" : "them"}.`,
        };
      }),
  },
  {
    id: "index-version-legacy",
    severity: "warning",
    since: "3.4",
    applies: "target",
    reference: SOURCES.convertLegacyIndexes,
    summary: "v0/v1 indexes stay in their old format after an in-place upgrade",
    check: function* (input) {
      for (const collection of input.collections) {
        const legacy = collection.metadata.indexes.filter((index) => {
          const version = numberValue(index.v);
          return version === 0 || version === 1;
        });
        if (legacy.length === 0) continue;
        const names = legacy.map((index) => `"${String(index.name)}" (v${numberValue(index.v)})`);
        yield {
          subject: collection.ns,
          message: `${names.join(", ")} use${legacy.length === 1 ? "s" : ""} an old index format. The restore rebuilt ${legacy.length === 1 ? "it" : "them"} in the current format (v2), but an in-place upgrade keeps the old one (v0 is not supported by WiredTiger; v1 lacks decimal128 and collation support): rebuild ${legacy.length === 1 ? "it" : "them"} on production to match what was rehearsed.`,
        };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Collection rules
// ---------------------------------------------------------------------------

/**
 * The fields of the `create` command (create.idl, MongoDB 8.0.13), the only
 * collection options a restore can pass back. Since 5.0, `create` "raise[s] an error
 * if passed a parameter not explicitly accepted by the command" (5.0 compatibility
 * notes, "Certain Commands Only Accept Recognized Parameters").
 */
export const CREATE_OPTIONS = new Set([
  "capped",
  "autoIndexId",
  "idIndex",
  "size",
  "max",
  "storageEngine",
  "validator",
  "validationLevel",
  "validationAction",
  "indexOptionDefaults",
  "viewOn",
  "pipeline",
  "collation",
  "changeStreamPreAndPostImages",
  "timeseries",
  "clusteredIndex",
  "recordIdsReplicated",
  "expireAfterSeconds",
  "encryptedFields",
  "temp",
  "flags",
]);

/** The documented limit on stages per pipeline since 5.0 (5.0 notes, "General Changes"). */
export const MAX_PIPELINE_STAGES = 1000;

/** A collection's validator, or undefined when it has none. */
function validatorOf(collection: BackedUpCollection): Document | undefined {
  const validator: unknown = collection.metadata.options.validator;
  return isPlainDocument(validator) ? validator : undefined;
}

/** A view's pipeline, or undefined for collections. */
function pipelineOf(collection: BackedUpCollection): unknown[] | undefined {
  if (collection.type !== "view") return undefined;
  const pipeline: unknown = collection.metadata.options.pipeline;
  return Array.isArray(pipeline) ? pipeline : [];
}

/** Every definition of a namespace that the server evaluates: validator and/or pipeline. */
function definitionsOf(collection: BackedUpCollection): { what: string; value: unknown }[] {
  const definitions: { what: string; value: unknown }[] = [];
  const validator = validatorOf(collection);
  if (validator !== undefined) definitions.push({ what: "validator", value: validator });
  const pipeline = pipelineOf(collection);
  if (pipeline !== undefined) definitions.push({ what: "view pipeline", value: pipeline });
  return definitions;
}

/** The `encryptedFields.fields` entries of a Queryable Encryption collection. */
function encryptedFieldsOf(collection: BackedUpCollection): Document[] {
  const encrypted: unknown = collection.metadata.options.encryptedFields;
  if (!isPlainDocument(encrypted) || !Array.isArray(encrypted.fields)) return [];
  return encrypted.fields.filter((field: unknown): field is Document => isPlainDocument(field));
}

/** The query types (`equality`, `range`, `rangePreview`, …) of one encrypted field. */
function queryTypesOf(field: Document): string[] {
  const queries: unknown = field.queries;
  const list = Array.isArray(queries) ? queries : [queries];
  return list
    .filter((query: unknown): query is Document => isPlainDocument(query))
    .map((query) => query.queryType)
    .filter((type: unknown): type is string => typeof type === "string");
}

const COLLECTION_RULES: readonly CompatibilityRule[] = [
  {
    id: "collection-unknown-option",
    severity: "problem",
    since: "5.0",
    applies: "target",
    reference: SOURCES.createCommand,
    summary: "collection options the create command does not accept make the restore fail",
    check: function* (input) {
      const ignored = new Set<string>(REJECTED_CREATE_OPTIONS);
      for (const collection of input.collections) {
        const unknown = Object.keys(collection.metadata.options).filter(
          (option) => !CREATE_OPTIONS.has(option) && !ignored.has(option),
        );
        if (unknown.length === 0) continue;
        yield {
          subject: collection.ns,
          message: `collection option${unknown.length === 1 ? "" : "s"} ${unknown.map((option) => `"${option}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not accepted by create since 5.0 ("unknown field"), so the restore fails. Remove ${unknown.length === 1 ? "it" : "them"} with collMod, or recreate the collection.`,
        };
      }
    },
  },
  {
    id: "collection-no-id-index",
    severity: "warning",
    since: "4.0",
    applies: "target",
    reference: SOURCES.compat40,
    summary: "collections created with autoIndexId: false get an _id index",
    check: function* (input) {
      for (const collection of input.collections) {
        if (collection.metadata.options.autoIndexId !== false) continue;
        yield {
          subject: collection.ns,
          message:
            "the collection was created with autoIndexId: false (no _id index), which MongoDB 4.0 and later refuse outside the local database. The restore creates it with a unique _id index, so documents with duplicate _id values fail to restore.",
        };
      }
    },
  },
  {
    id: "encryption-preview",
    severity: "problem",
    since: "7.0",
    applies: "crossing",
    reference: SOURCES.compat70,
    summary: "Queryable Encryption collections from the 6.x public preview do not work on 7.0",
    check: function* (input) {
      // Queryable Encryption collections exist since 6.0; before that the option is unknown.
      if (input.source !== undefined && input.source.major !== 6) return;
      for (const collection of input.collections) {
        if (collection.metadata.options.encryptedFields === undefined) continue;
        yield {
          subject: collection.ns,
          message:
            "the collection uses Queryable Encryption (encryptedFields) from the 6.x public preview, which is incompatible with the 7.0 GA release: create a new encrypted collection on 7.0 and move the data in with a 7.0 driver (backups hold the encrypted values, which a 7.0 driver cannot query).",
        };
      }
    },
  },
  {
    id: "encryption-range-preview",
    severity: "problem",
    since: "8.0",
    applies: "target",
    reference: SOURCES.compat80,
    summary: "the rangePreview Queryable Encryption algorithm was removed",
    check: function* (input) {
      for (const collection of input.collections) {
        const fields = encryptedFieldsOf(collection).filter((field) =>
          queryTypesOf(field).includes("rangePreview"),
        );
        if (fields.length === 0) continue;
        const paths = fields.map((field) => `"${String(field.path)}"`).join(", ");
        yield {
          subject: collection.ns,
          message: `encrypted field${fields.length === 1 ? "" : "s"} ${paths} use${fields.length === 1 ? "s" : ""} the rangePreview algorithm, which MongoDB 8.0 removed: the collection must be dropped before upgrading and recreated with the range algorithm.`,
        };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// View and validator rules
// ---------------------------------------------------------------------------

const DEFINITION_RULES: readonly CompatibilityRule[] = [
  {
    id: "view-pipeline-too-long",
    severity: "problem",
    since: "5.0",
    applies: "target",
    reference: SOURCES.compat50,
    summary: "pipelines are limited to 1000 stages",
    check: function* (input) {
      for (const collection of input.collections) {
        const pipeline = pipelineOf(collection);
        if (pipeline === undefined || pipeline.length <= MAX_PIPELINE_STAGES) continue;
        yield {
          subject: collection.ns,
          message: `the view's pipeline has ${pipeline.length} stages; since 5.0 a pipeline may have at most ${MAX_PIPELINE_STAGES}, so the view cannot be queried.`,
        };
      }
    },
  },
  {
    id: "view-on-buckets",
    severity: "warning",
    since: "6.1",
    applies: "target",
    reference: SOURCES.compat70,
    summary: "views on system.buckets collections are not permitted",
    check: function* (input) {
      for (const collection of input.collections) {
        const viewOn: unknown = collection.metadata.options.viewOn;
        if (collection.type !== "view" || typeof viewOn !== "string") continue;
        if (!viewOn.startsWith("system.buckets.")) continue;
        yield {
          subject: collection.ns,
          message: `the view reads the internal time series bucket collection "${viewOn}"; MongoDB's 6.1 notes say such views are not permitted and must be dropped when upgrading (servers up to 8.0.13 still create them, hence a warning). Point it at the time series collection instead.`,
        };
      }
    },
  },
  {
    id: "regex-invalid-options",
    severity: "problem",
    since: "5.1",
    applies: "target",
    reference: SOURCES.compat60,
    summary: "invalid $regex options in a validator block every write",
    check: function* (input) {
      for (const collection of input.collections) {
        for (const { what, value } of definitionsOf(collection)) {
          const invalid = new Set(regexOptionsIn(value).flatMap(invalidRegexOptions));
          if (invalid.size === 0) continue;
          const options = [...invalid].map((option) => `"${option}"`).join(", ");
          const effect =
            what === "validator"
              ? "from 5.1 on such a validator blocks every insert and update, and current servers refuse to create it"
              : "current servers reject such a pattern when the view is queried";
          yield {
            subject: collection.ns,
            message: `the ${what} uses regular expression option${invalid.size === 1 ? "" : "s"} ${options}, which MongoDB does not accept (only i, m, x, s and u): ${effect}. Fix it with collMod.`,
          };
        }
      }
    },
  },
  {
    id: "javascript-removed-functions",
    severity: "problem",
    since: "6.0",
    applies: "target",
    reference: SOURCES.compat60,
    summary: "static Array.* and String.* functions were removed from server-side JavaScript",
    check: function* (input) {
      for (const collection of input.collections) {
        for (const { what, value } of definitionsOf(collection)) {
          const calls = new Set(javaScriptSources(value).flatMap(removedStaticFunctionCalls));
          if (calls.size === 0) continue;
          yield {
            subject: collection.ns,
            message: `the ${what}'s server-side JavaScript calls ${[...calls].join(", ")}, which MongoDB 6.0 removed (MozJS-91): it fails with "is not a function". Use the prototype methods instead, e.g. a.concat(b).`,
          };
        }
      }
    },
  },
  {
    id: "javascript-deprecated",
    severity: "warning",
    since: "8.0",
    applies: "target",
    reference: SOURCES.compat80,
    summary: "server-side JavaScript ($function, $accumulator, $where) is deprecated",
    check: function* (input) {
      const javaScriptOperators = ["$function", "$accumulator", "$where"];
      for (const collection of input.collections) {
        for (const { what, value } of definitionsOf(collection)) {
          const used = [...operatorsUsed(value)].filter((operator) =>
            javaScriptOperators.includes(operator),
          );
          if (used.length === 0) continue;
          yield {
            subject: collection.ns,
            message: `the ${what} uses ${used.sort().join(", ")}: server-side JavaScript is deprecated in 8.0 (it still runs, and logs a warning each time). Plan to replace it with aggregation operators.`,
          };
        }
      }
    },
  },
  {
    id: "rank-null-missing",
    severity: "warning",
    since: "8.0",
    applies: "crossing",
    reference: SOURCES.compat80,
    summary: "$rank and $denseRank treat null and missing values the same",
    check: function* (input) {
      for (const collection of input.collections) {
        const pipeline = pipelineOf(collection);
        if (pipeline === undefined) continue;
        const used = [...operatorsUsed(pipeline)].filter(
          (operator) => operator === "$rank" || operator === "$denseRank",
        );
        if (used.length === 0) continue;
        yield {
          subject: collection.ns,
          message: `the view uses ${used.sort().join(" and ")}: from 8.0 on, null and missing sortBy values rank the same, so documents with either may get different ranks than on the source.`,
        };
      }
    },
  },
  {
    id: "add-floating-point",
    severity: "warning",
    since: "6.1",
    applies: "crossing",
    reference: SOURCES.compat70,
    summary: "$add no longer corrects floating-point rounding errors",
    check: function* (input) {
      for (const collection of input.collections) {
        for (const { what, value } of definitionsOf(collection)) {
          if (!operatorsUsed(value).has("$add")) continue;
          yield {
            subject: collection.ns,
            message: `the ${what} uses $add, which from 6.1 on no longer accounts for floating-point rounding errors ([0.1, 0.2, 0.3] adds up to 0.6000000000000001 instead of 0.6): results on doubles may differ in the last digits.`,
          };
        }
      }
    },
  },
  {
    id: "null-matches-undefined",
    severity: "warning",
    since: "8.0",
    applies: "crossing",
    reference: SOURCES.compat80,
    summary: "equality with null no longer matches undefined values",
    check: function* (input) {
      for (const collection of input.collections) {
        const validator = validatorOf(collection);
        const validatorPaths = validator === undefined ? [] : nullEqualityPaths(validator);
        if (validatorPaths.length > 0) {
          yield {
            subject: collection.ns,
            message: `the validator compares ${quoteList(validatorPaths)} with null: from 8.0 on that no longer matches fields holding the deprecated undefined type, so updates to such documents fail validation. The live rehearsal counts how many documents hold undefined there.`,
          };
        }
        const pipeline = pipelineOf(collection);
        if (pipeline === undefined) continue;
        const viewPaths = [
          ...new Set(matchQueries(pipeline).flatMap((query) => nullEqualityPaths(query))),
        ];
        const joins = hasEqualityLookup(pipeline);
        if (viewPaths.length === 0 && !joins) continue;
        const what = [
          ...(viewPaths.length > 0 ? [`compares ${quoteList(viewPaths.sort())} with null`] : []),
          ...(joins ? ["joins with $lookup on localField/foreignField"] : []),
        ].join(" and ");
        yield {
          subject: collection.ns,
          message: `the view ${what}: from 8.0 on null no longer matches the deprecated undefined type, so documents holding undefined there drop out of (or into) the view's results.`,
        };
      }
    },
  },
];

/** `"a", "b"` for messages. */
function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

// ---------------------------------------------------------------------------
// Stored JavaScript, users and roles
// ---------------------------------------------------------------------------

/** A role name in the shape LDAP authorization maps groups to: a distinguished name. */
const LDAP_DN_PATTERN = /^(cn|ou|dc|uid|o)=[^,]+(,|$)/i;

/** `user@db` for messages (never credentials). */
function userName(user: Document): string {
  return `${String(user.user)}@${String(user.db)}`;
}

/** The credential mechanisms a user document stores (`SCRAM-SHA-256`, …). */
function mechanismsOf(user: Document): string[] {
  return isPlainDocument(user.credentials) ? Object.keys(user.credentials) : [];
}

/** At most this many names are listed in one finding; the rest are counted. */
const MAX_NAMES_LISTED = 10;

/** `a, b, c and 4 more` for messages. */
function namesList(names: readonly string[]): string {
  const listed = names.slice(0, MAX_NAMES_LISTED).join(", ");
  return names.length > MAX_NAMES_LISTED
    ? `${listed} and ${names.length - MAX_NAMES_LISTED} more`
    : listed;
}

const SECURITY_RULES: readonly CompatibilityRule[] = [
  {
    id: "javascript-stored-removed-functions",
    severity: "warning",
    since: "6.0",
    applies: "target",
    reference: SOURCES.compat60,
    summary: "stored functions (system.js) call removed static Array.*/String.* functions",
    check: function* (input) {
      for (const stored of input.storedJavaScript) {
        const affected: string[] = [];
        for (const document of stored.documents) {
          const source = codeText(document.value);
          if (source === undefined || removedStaticFunctionCalls(source).length === 0) continue;
          affected.push(String(document._id));
        }
        if (affected.length === 0) continue;
        yield {
          subject: stored.ns,
          message: `stored function${affected.length === 1 ? "" : "s"} ${namesList(affected)} call${affected.length === 1 ? "s" : ""} static Array.* or String.* functions that MongoDB 6.0 removed: whatever calls ${affected.length === 1 ? "it" : "them"} from server-side JavaScript fails with "is not a function".`,
        };
      }
    },
  },
  {
    id: "user-mongodb-cr",
    severity: "problem",
    since: "4.0",
    applies: "target",
    reference: SOURCES.compat40,
    summary: "users with only MONGODB-CR credentials cannot log in",
    check: function* (input) {
      const users = input.users.filter((user) => {
        const mechanisms = mechanismsOf(user);
        return (
          mechanisms.includes("MONGODB-CR") && !mechanisms.some((name) => name.startsWith("SCRAM-"))
        );
      });
      if (users.length === 0) return;
      yield {
        subject: "users",
        message: `${namesList(users.map(userName))} only ${users.length === 1 ? "has" : "have"} MONGODB-CR credentials, which MongoDB 4.0 removed: ${users.length === 1 ? "it" : "they"} cannot log in. Reset ${users.length === 1 ? "its password" : "their passwords"} to create SCRAM credentials.`,
      };
    },
  },
  {
    id: "user-scram-sha1-only",
    severity: "warning",
    since: "5.1",
    applies: "target",
    reference: SOURCES.compat60,
    summary: "SCRAM-SHA-1 is off by default in FIPS mode",
    check: function* (input) {
      const users = input.users.filter((user) => {
        const mechanisms = mechanismsOf(user);
        return mechanisms.includes("SCRAM-SHA-1") && !mechanisms.includes("SCRAM-SHA-256");
      });
      if (users.length === 0) return;
      yield {
        subject: "users",
        message: `${namesList(users.map(userName))} only ${users.length === 1 ? "has" : "have"} SCRAM-SHA-1 credentials: from 5.1 on, servers in FIPS mode (Enterprise) disable SCRAM-SHA-1 by default, so ${users.length === 1 ? "it" : "they"} could not log in there. Update the users with mechanisms: ["SCRAM-SHA-256"] if you run FIPS mode.`,
      };
    },
  },
  {
    id: "role-ldap-mapping",
    severity: "warning",
    since: "8.0",
    applies: "target",
    reference: SOURCES.compat80,
    summary: "LDAP authentication and authorization are deprecated",
    check: function* (input) {
      const roles = input.roles
        .filter((role) => typeof role.role === "string" && LDAP_DN_PATTERN.test(role.role))
        .map((role) => `${String(role.role)}@${String(role.db)}`);
      if (roles.length === 0) return;
      yield {
        subject: "roles",
        message: `${namesList(roles)} look${roles.length === 1 ? "s" : ""} like LDAP group mappings (distinguished names): LDAP authentication and authorization are deprecated in 8.0 and will be removed in a future major release. Plan a move to OIDC or X.509.`,
      };
    },
  },
];

/**
 * Every encoded rule, in the order findings are listed. Exported for the
 * documentation and for tests; `analyzeUpgradeCompatibility` is the way to run them.
 */
export const COMPATIBILITY_RULES: readonly CompatibilityRule[] = [
  ...INDEX_RULES,
  ...COLLECTION_RULES,
  ...DEFINITION_RULES,
  ...SECURITY_RULES,
];

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

/**
 * True when a rule applies to an upgrade from `source` to `target` (see the file
 * header). With an unknown source, crossing rules apply: better a warning too many.
 */
export function ruleApplies(
  rule: Pick<CompatibilityRule, "since" | "applies">,
  source: ServerVersion | undefined,
  target: ServerVersion,
): boolean {
  if (!isAtLeast(target, rule.since)) return false;
  if (rule.applies === "target" || source === undefined) return true;
  return !isAtLeast(source, rule.since);
}

/**
 * Runs every applicable rule over a backup's definitions, plus the upgrade path
 * checks (downgrade, one major at a time, unknown versions).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when `targetVersion` is not a version.
 */
export function analyzeUpgradeCompatibility(input: CompatibilityInput): CompatibilityReport {
  const target = parseTargetVersion(input.targetVersion);
  const source = parseServerVersion(input.sourceVersion);
  const ruleInput: RuleInput = {
    collections: input.collections,
    users: input.users ?? [],
    roles: input.roles ?? [],
    storedJavaScript: input.storedJavaScript ?? [],
    source,
    target,
  };

  const findings: CompatibilityFinding[] = [...upgradePathFindings(input, source, target)];
  for (const unreadable of input.unreadable ?? []) {
    findings.push({
      rule: "metadata-unreadable",
      severity: "warning",
      subject: unreadable.ns,
      message: `the metadata could not be read, so the namespace was not analysed: ${unreadable.reason}`,
      since: releaseName(target),
      reference: SOURCES.upgrade80,
    });
  }

  let rulesChecked = 0;
  for (const rule of COMPATIBILITY_RULES) {
    if (!ruleApplies(rule, source, target)) continue;
    rulesChecked += 1;
    for (const hit of rule.check(ruleInput)) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        subject: hit.subject,
        message: hit.message,
        since: rule.since,
        reference: rule.reference,
      });
    }
  }

  // Problems first; the sort is stable, so rule order is kept within each severity.
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return {
    sourceVersion: input.sourceVersion,
    targetVersion: formatVersion(target),
    upgradePath: source === undefined ? [] : upgradePath(source, target),
    ok: findings.every((finding) => finding.severity !== "problem"),
    findings,
    rulesChecked,
  };
}

function severityRank(severity: CompatibilitySeverity): number {
  return severity === "problem" ? 0 : 1;
}

/**
 * Findings about the versions themselves: a rehearsal "upgrading" to an older
 * release, to the same one, across several majors, or beyond the notes encoded here.
 */
function upgradePathFindings(
  input: CompatibilityInput,
  source: ServerVersion | undefined,
  target: ServerVersion,
): CompatibilityFinding[] {
  const finding = (
    rule: string,
    severity: CompatibilitySeverity,
    message: string,
    reference: string = SOURCES.upgrade80,
  ): CompatibilityFinding => ({
    rule,
    severity,
    subject: "upgrade",
    message,
    since: releaseName(target),
    reference,
  });
  const findings: CompatibilityFinding[] = [];

  // Newer than the newest encoded release (Rapid Releases such as 8.2 included).
  const newestKnown = parseServerVersion(NEWEST_KNOWN_RELEASE);
  if (
    newestKnown !== undefined &&
    compareVersions({ ...target, patch: undefined }, newestKnown) > 0
  ) {
    findings.push(
      finding(
        "upgrade-target-unknown",
        "warning",
        `MongoShield encodes the compatibility notes up to ${NEWEST_KNOWN_RELEASE}; changes made in ${releaseName(target)} were not checked. Read its "Compatibility Changes" page as well.`,
      ),
    );
  }

  if (source === undefined) {
    findings.push(
      finding(
        "upgrade-source-unknown",
        "warning",
        `the backup does not record a usable source version ("${input.sourceVersion}"), so every rule that depends on it was applied, and the in-place upgrade path is unknown.`,
      ),
    );
    return findings;
  }

  const order = compareVersions({ ...source, patch: undefined }, { ...target, patch: undefined });
  if (order > 0) {
    findings.push(
      finding(
        "upgrade-downgrade",
        "problem",
        `the backup comes from MongoDB ${input.sourceVersion}, which is newer than ${formatVersion(target)}: this would be a downgrade, which a rehearsal does not cover (features of the newer release may not restore). Pick a newer target.`,
      ),
    );
  } else if (order === 0) {
    findings.push(
      finding(
        "upgrade-same-release",
        "warning",
        `the backup already comes from MongoDB ${input.sourceVersion} (${releaseName(target)} series): this rehearses a patch upgrade at most.`,
      ),
    );
  } else {
    const path = upgradePath(source, target);
    if (path.length > 1) {
      findings.push(
        finding(
          "upgrade-multiple-steps",
          "warning",
          `an in-place upgrade from ${releaseName(source)} must go through every release, one at a time, and set the feature compatibility version after each: ${[releaseName(source), ...path].join(" → ")}. This rehearsal restored straight into ${formatVersion(target)}, so it proves the data works there, not each intermediate step.`,
        ),
      );
    }
  }
  return findings;
}
