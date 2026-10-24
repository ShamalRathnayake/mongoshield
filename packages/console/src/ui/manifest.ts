/**
 * Reading a backup manifest in the browser.
 *
 * `BackupDetail.manifest` is typed `unknown` in the API contract because it is the file
 * exactly as stored (format: docs/specs/FORMAT.md). This module narrows the fields the
 * UI shows — source, compression, encryption, consistency, labels, namespaces and
 * totals — and ignores everything else, as the spec asks readers to do.
 */

/** One namespace as listed in a manifest. */
export interface ManifestNamespace {
  readonly ns: string;
  readonly type: string;
  readonly documents: number;
  readonly bytesRaw: number;
  /** Sum of the stored sizes of its data files. */
  readonly bytesStored: number;
}

/** The parts of a manifest the UI shows. Missing fields are undefined. */
export interface ManifestSummary {
  readonly tool?: string | undefined;
  readonly topology?: string | undefined;
  readonly serverVersion?: string | undefined;
  readonly compression?: string | undefined;
  readonly encryption?:
    | { readonly scheme: string; readonly recipients: readonly string[] }
    | undefined;
  readonly consistencyMode?: string | undefined;
  readonly consistencyWarning?: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly namespaces: readonly ManifestNamespace[];
  readonly bytesRaw?: number | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Sum of `size` over an array of stored files `{ key, size, sha256 }`. */
function storedSize(files: unknown): number {
  if (!Array.isArray(files)) return 0;
  let total = 0;
  for (const file of files) total += asNumber(asRecord(file)?.size) ?? 0;
  return total;
}

/** Extracts what the UI shows from a manifest of unknown shape. Never throws. */
export function summarizeManifest(manifest: unknown): ManifestSummary {
  const root = asRecord(manifest) ?? {};
  const source = asRecord(root.source);
  const consistency = asRecord(root.consistency);
  const encryption = asRecord(root.encryption);
  const totals = asRecord(root.totals);

  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(root.labels) ?? {})) {
    const text = asString(value);
    if (text !== undefined) labels[key] = text;
  }

  const namespaces: ManifestNamespace[] = [];
  if (Array.isArray(root.namespaces)) {
    for (const item of root.namespaces) {
      const entry = asRecord(item);
      const ns = asString(entry?.ns);
      if (entry === undefined || ns === undefined) continue;
      namespaces.push({
        ns,
        type: asString(entry.type) ?? "collection",
        documents: asNumber(entry.documents) ?? 0,
        bytesRaw: asNumber(entry.bytesRaw) ?? 0,
        bytesStored: storedSize(entry.files),
      });
    }
  }

  const recipients = Array.isArray(encryption?.recipients)
    ? encryption.recipients.filter(
        (recipient): recipient is string => typeof recipient === "string",
      )
    : [];

  return {
    tool: asString(root.tool),
    topology: asString(source?.topology),
    serverVersion: asString(source?.serverVersion),
    compression: asString(root.compression),
    encryption:
      encryption === undefined
        ? undefined
        : { scheme: asString(encryption.scheme) ?? "unknown", recipients },
    consistencyMode: asString(consistency?.mode),
    consistencyWarning: asString(consistency?.warning),
    labels,
    namespaces,
    bytesRaw: asNumber(totals?.bytesRaw),
  };
}
