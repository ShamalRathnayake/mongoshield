/**
 * The names MongoShield reports to OpenTelemetry: span names, attribute keys
 * and metric instruments. They are part of the public contract (dashboards and
 * alerts are built on them), so they live in one place and are listed in
 * docs/guides/observability.md. Rename nothing within a major version.
 *
 * Naming follows the OpenTelemetry conventions: dotted lowercase names under a
 * `mongoshield.` namespace, durations in seconds, `error.type` for failures.
 */

/** Instrumentation scope name passed to `getTracer` / `getMeter`. */
export const INSTRUMENTATION_SCOPE = "mongoshield";

/** One span per public operation, named `mongoshield.<operation>`. */
export type TracedOperation = "backup" | "restore" | "verify" | "prune" | "drill";

/** The span name of a public operation. */
export function spanName(operation: TracedOperation): string {
  return `mongoshield.${operation}`;
}

/**
 * Spans the engines open inside an operation's span, one per unit of work, so a
 * trace shows which collection (or the change replay) a slow operation spent its
 * time on. Namespace names appear on them only with `includeNamespaces`.
 */
export const ENGINE_SPANS = {
  /** Dumping one namespace (one span per part for collections split into parts). */
  backupNamespace: "mongoshield.backup.namespace",
  /** Restoring one collection: create, documents, indexes. */
  restoreNamespace: "mongoshield.restore.namespace",
  /** Replaying a converge backup's change window, or the journal of a point-in-time restore. */
  restoreReplay: "mongoshield.restore.replay",
  /** Checking one namespace's files. */
  verifyNamespace: "mongoshield.verify.namespace",
} as const;

/** The name of an engine-internal span. */
export type EngineSpanName = (typeof ENGINE_SPANS)[keyof typeof ENGINE_SPANS];

/** Attribute keys used on spans and metrics. */
export const ATTRIBUTES = {
  /** Which public operation a metric point belongs to (`backup`, `restore`, …). */
  operation: "mongoshield.operation",
  /** `success`, `failure`, or (backups only) `checkpointed`. */
  status: "mongoshield.status",
  backupId: "mongoshield.backup.id",
  /** How a backup invocation ended: `complete`, or `checkpointed` (to be resumed). */
  backupStatus: "mongoshield.backup.status",
  /** Restore mode, verify mode, consistency mode: whichever applies to the span. */
  mode: "mongoshield.mode",
  consistency: "mongoshield.consistency",
  dryRun: "mongoshield.dry_run",
  ok: "mongoshield.ok",
  documents: "mongoshield.documents",
  bytesRaw: "mongoshield.bytes.raw",
  bytesStored: "mongoshield.bytes.stored",
  bytesChecked: "mongoshield.bytes.checked",
  filesChecked: "mongoshield.files.checked",
  /** How many namespaces were involved (always safe to report). */
  namespaceCount: "mongoshield.namespaces.count",
  /** The namespace names themselves: only with `telemetry.includeNamespaces`. */
  namespaceNames: "mongoshield.namespaces.names",
  /** One namespace (engine-internal spans): only with `telemetry.includeNamespaces`. */
  namespace: "mongoshield.namespace",
  problems: "mongoshield.problems",
  /** Which part of a split collection a backup namespace span dumped (0-based). */
  part: "mongoshield.part",
  /** Change events applied by a replay span. */
  events: "mongoshield.replay.events",
  deletedBackups: "mongoshield.prune.deleted_backups",
  deletedBytes: "mongoshield.prune.deleted_bytes",
  /** A drill's recovery time: how long the restore took, in milliseconds. */
  rtoMs: "mongoshield.drill.rto_ms",
  /** `true` on restore-duration points that come from a drill. */
  drill: "mongoshield.drill",
  /** Byte kind on the bytes counter: `raw` (BSON) or `stored` (compressed, encrypted). */
  bytesKind: "mongoshield.bytes.kind",
  /** The OpenTelemetry semantic-convention key for "what kind of failure": the error code. */
  errorType: "error.type",
} as const;

/** Metric instrument names, units and descriptions. */
export const METRICS = {
  documents: {
    name: "mongoshield.documents",
    unit: "{document}",
    description: "Documents written by backups, restored, verified or drilled.",
  },
  bytes: {
    name: "mongoshield.bytes",
    unit: "By",
    description: "Bytes processed, by operation and kind (raw BSON or stored).",
  },
  backups: {
    name: "mongoshield.backups",
    unit: "{backup}",
    description: "Backup runs, by status (success, checkpointed or failure).",
  },
  backupDuration: {
    name: "mongoshield.backup.duration",
    unit: "s",
    description: "How long backups took, including failed ones.",
  },
  restoreDuration: {
    name: "mongoshield.restore.duration",
    unit: "s",
    description: "How long restores took, including the restores of restore drills (the RTO).",
  },
} as const;
