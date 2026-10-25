/**
 * Reading MongoShield's --json output back out of a pod log.
 *
 * With --json, MongoShield prints exactly one JSON document on stdout when it
 * finishes: a run report (`mongoshield run`), a restore result (`mongoshield
 * restore`), a drill report (`mongoshield drill`), a deletion result (`mongoshield
 * delete`), or `{ "error": { … } }` when the command failed before producing one.
 * Status lines and warnings go to stderr. The pod log interleaves both streams, so
 * the document has to be found among other lines.
 *
 * MongoShield pretty-prints the document with two-space indentation, which makes it
 * easy to spot: it starts with a line that is exactly "{" and ends with a line that is
 * exactly "}". Nested lines are always indented, and stderr lines are never a bare
 * brace. Every such block is parsed and the last valid one wins.
 */

/** What a finished command reported. */
export type CommandOutput =
  | { readonly kind: "run"; readonly report: RunReportOutput }
  | { readonly kind: "restore"; readonly result: RestoreResultOutput }
  | { readonly kind: "drill"; readonly report: DrillReportOutput }
  | { readonly kind: "delete"; readonly result: DeleteResultOutput }
  | { readonly kind: "error"; readonly error: ErrorOutput }
  | { readonly kind: "none" };

/**
 * The fields of MongoShield's run report the operator uses. The full shape is the
 * library's `RunReport` (src/schedule/report.ts), a documented public contract.
 */
export interface RunReportOutput {
  readonly runId: string;
  readonly status: "success" | "failure" | "skipped" | "checkpointed";
  readonly durationMs: number;
  readonly storage?: string;
  readonly lock?: { readonly heldBy?: { readonly host?: string; readonly expiresAt?: string } };
  readonly backup?: {
    readonly id: string;
    readonly status?: "complete" | "checkpointed";
    readonly parts?: { readonly done: number; readonly total: number };
    readonly namespaces: number;
    readonly documents: number;
    readonly bytesRaw: number;
    readonly bytesStored: number;
    readonly durationMs: number;
    readonly kind?: "full" | "incremental";
    readonly parent?: string;
    readonly changes?: number;
    readonly fullBackupReason?: string;
  };
  readonly verify?: {
    readonly mode: string;
    readonly ok: boolean;
    /** Drills: the measured restore time. */
    readonly rtoMs?: number;
    readonly problems: readonly { readonly subject: string; readonly problem: string }[];
  };
  readonly prune?: { readonly deletedBackups: number; readonly kept: number };
  readonly error?: {
    readonly step: string;
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
  };
}

/** The fields of the library's `RestoreResult` the operator uses. */
export interface RestoreResultOutput {
  readonly plan: { readonly backupId: string; readonly entries: readonly unknown[] };
  readonly dryRun: boolean;
  readonly documentsRestored: number;
  readonly durationMs: number;
}

/** The fields of the library's `DrillReport` (`mongoshield drill --json`) the operator uses. */
export interface DrillReportOutput {
  readonly backupId: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** The RTO: how long the restore took. */
  readonly restoreDurationMs: number;
  readonly documentsRestored: number;
  readonly namespaces: readonly unknown[];
  readonly problems: readonly { readonly subject: string; readonly problem: string }[];
}

/** The library's `DeleteBackupResult` (`mongoshield delete --json`). */
export interface DeleteResultOutput {
  readonly id: string;
  readonly deletedObjects: number;
  readonly deletedBytes: number;
  readonly deletedAt: string;
}

/** `{ "error": … }`, printed by the CLI when a command fails (src/cli/report-error.ts). */
export interface ErrorOutput {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly exitCode?: number;
}

/** Every top-level JSON object found in `log`, in order. */
export function extractJsonDocuments(log: string): unknown[] {
  const lines = log.split(/\r?\n/);
  const documents: unknown[] = [];
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "{") {
      start = index;
    } else if (line === "}" && start !== -1) {
      try {
        documents.push(JSON.parse(lines.slice(start, index + 1).join("\n")) as unknown);
      } catch {
        // Not a JSON document after all (or a truncated one); keep looking.
      }
      start = -1;
    }
  }
  return documents;
}

/** Classifies the last JSON document in a pod log. */
export function parseCommandOutput(log: string): CommandOutput {
  const documents = extractJsonDocuments(log);
  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const output = classify(documents[index]);
    if (output.kind !== "none") return output;
  }
  return { kind: "none" };
}

/** Works out which of the three documents `value` is. */
function classify(value: unknown): CommandOutput {
  if (!isRecord(value)) return { kind: "none" };
  if (isRecord(value.error) && typeof value.error.code === "string" && !("runId" in value)) {
    const error = value.error;
    return {
      kind: "error",
      error: {
        code: error.code as string,
        message: typeof error.message === "string" ? error.message : "",
        ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
        ...(typeof error.exitCode === "number" ? { exitCode: error.exitCode } : {}),
      },
    };
  }
  if (typeof value.runId === "string" && typeof value.status === "string") {
    return { kind: "run", report: value as unknown as RunReportOutput };
  }
  if (isRecord(value.plan) && typeof value.documentsRestored === "number") {
    return { kind: "restore", result: value as unknown as RestoreResultOutput };
  }
  if (typeof value.restoreDurationMs === "number" && typeof value.ok === "boolean") {
    return { kind: "drill", report: value as unknown as DrillReportOutput };
  }
  if (typeof value.deletedObjects === "number" && typeof value.deletedAt === "string") {
    return { kind: "delete", result: value as unknown as DeleteResultOutput };
  }
  return { kind: "none" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
