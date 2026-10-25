import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { toPartRange } from "../engine/backup-parts.ts";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { PutOptions, StorageAdapter } from "../storage/types.ts";
import { storedFieldOrder } from "./field-order.ts";
import { manifestKey } from "./layout.ts";
import {
  FULL_BACKUP_FORMAT_VERSION,
  INCREMENTAL_BACKUP_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSION,
  type Manifest,
} from "./manifest.ts";
import { parseManifest, readManifest, serializeManifest, writeManifest } from "./manifest-io.ts";

const SHA = "a".repeat(64);

/** A complete, valid manifest with one collection and one view. */
function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    formatVersion: FULL_BACKUP_FORMAT_VERSION,
    id: "2026-11-14T03-00-04Z_7f3a9c",
    tool: "mongoshield@2.0.0",
    status: "complete",
    startedAt: "2026-11-14T03:00:04.123Z",
    completedAt: "2026-11-14T03:01:10+00:00",
    source: { topology: "replicaSet", serverVersion: "8.0.4", clusterId: "c0ffee" },
    consistency: { mode: "snapshot", from: { t: 1763089204, i: 3 }, to: { t: 1763089204, i: 3 } },
    compression: "zstd",
    encryption: { scheme: "age-v1", recipients: ["age1example"] },
    labels: { env: "prod" },
    namespaces: [
      {
        ns: "app.users",
        db: "app",
        collection: "users",
        type: "collection",
        documents: 2,
        bytesRaw: 100,
        files: [{ key: "app/users.bson.zst.age", size: 80, sha256: SHA }],
        metadata: { key: "app/users.metadata.json.age", size: 300, sha256: SHA },
      },
      {
        ns: "app.active",
        db: "app",
        collection: "active",
        type: "view",
        documents: 0,
        bytesRaw: 0,
        files: [],
        metadata: { key: "app/active.metadata.json.age", size: 250, sha256: SHA },
      },
    ],
    totals: { namespaces: 2, documents: 2, bytesRaw: 100, bytesStored: 630 },
    ...overrides,
  };
}

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("serializeManifest", () => {
  it("writes pretty-printed JSON with a trailing newline", () => {
    const text = serializeManifest(sampleManifest());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "formatVersion": 1,');
  });

  it("round-trips through parseManifest", () => {
    const manifest = sampleManifest();
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it("accepts unencrypted backups and minimal consistency info", () => {
    const manifest = sampleManifest({ encryption: null, consistency: { mode: "none" } });
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it("refuses to write a manifest it could not read back", () => {
    // Note: this currently throws a ZodError rather than a MongoShieldError.
    expect(() => serializeManifest(sampleManifest({ id: "not-an-id" }))).toThrow();
  });
});

describe("part ranges keep the stored field order of _id documents", () => {
  /** A manifest whose one data part is bounded by embedded-document `_id`s. */
  function withRange(): Manifest {
    // `{ b: 1, "2": 1 }` as the server stores it: `b` first. A plain JavaScript object
    // would list "2" first, which is a different `_id` (and sorts elsewhere).
    const lower = new Map<string, unknown>([
      ["b", 1],
      ["2", 1],
    ]);
    const upper = new Map<string, unknown>([
      ["b", 5],
      ["10", 0],
    ]);
    const range = toPartRange({ lower: { value: lower }, upper: { value: upper } });
    const [users, view] = sampleManifest().namespaces;
    if (users === undefined || view === undefined) throw new Error("fixture");
    const files = [
      { ...users.files[0], key: "app/users.000.bson.zst.age", size: 80, sha256: SHA, range },
    ];
    return sampleManifest({ namespaces: [{ ...users, files }, view] });
  }

  it('writes the bounds in stored order (JSON.stringify would put "2" first)', () => {
    const text = serializeManifest(withRange());
    expect(text.replace(/\s/g, "")).toContain(
      '"from":{"b":{"$numberInt":"1"},"2":{"$numberInt":"1"}}',
    );
    expect(text.replace(/\s/g, "")).toContain(
      '"to":{"b":{"$numberInt":"5"},"10":{"$numberInt":"0"}}',
    );
  });

  it("reads them back with the order recorded, so history compares the right _id", () => {
    const parsed = parseManifest(serializeManifest(withRange()));
    const range = parsed.namespaces[0]?.files[0]?.range;
    expect(storedFieldOrder(range?.from as object)).toEqual(["b", "2"]);
    expect(storedFieldOrder(range?.to as object)).toEqual(["b", "10"]);
  });
});

describe("incremental manifests", () => {
  /** A valid incremental manifest: changes only, chained to a full backup. */
  function incremental(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...sampleManifest({
        id: "2026-11-14T04-00-02Z_1a2b3c",
        namespaces: [],
        consistency: {
          mode: "converge",
          from: { t: 1763089204, i: 3 },
          to: { t: 1763092802, i: 1 },
        },
        totals: { namespaces: 0, documents: 0, bytesRaw: 0, bytesStored: 40 },
      }),
      formatVersion: INCREMENTAL_BACKUP_FORMAT_VERSION,
      kind: "incremental",
      chain: {
        base: "2026-11-14T03-00-04Z_7f3a9c",
        parent: "2026-11-14T03-00-04Z_7f3a9c",
        length: 1,
      },
      changes: { key: "_changes/window.bson.zst.age", size: 40, sha256: SHA, events: 3 },
      ...overrides,
    };
  }

  it("round-trips with kind, chain and changes", () => {
    const parsed = parseManifest(JSON.stringify(incremental()));
    expect(parsed).toMatchObject({ formatVersion: 2, kind: "incremental", chain: { length: 1 } });
    expect(parseManifest(serializeManifest(parsed))).toEqual(parsed);
  });

  it.each([
    ["format version 1", { formatVersion: 1 }, "formatVersion"],
    ["no chain", { chain: undefined }, "chain"],
    ["no changes file", { changes: undefined }, "changes"],
    ["no change range", { consistency: { mode: "converge" } }, "consistency"],
    ["mode none", { consistency: { mode: "none" } }, "consistency"],
  ])("refuses an incremental with %s", (_label, overrides, field) => {
    const error = errorFrom(() => parseManifest(JSON.stringify(incremental(overrides))));
    expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    expect((error as Error).message).toContain(field);
  });

  it("requires every entry of an incremental to say what it holds", () => {
    const [users] = sampleManifest().namespaces;
    if (users === undefined) throw new Error("fixture");
    const metadataOnly = { ...users, documents: 0, files: [], content: "metadata" };
    const valid = incremental({
      namespaces: [metadataOnly],
      totals: { namespaces: 1, documents: 0, bytesRaw: 0, bytesStored: 340 },
    });
    expect(parseManifest(JSON.stringify(valid)).namespaces[0]?.content).toBe("metadata");
    for (const namespaces of [[users], [{ ...metadataOnly, files: users.files }]]) {
      const error = errorFrom(() => parseManifest(JSON.stringify(incremental({ namespaces }))));
      expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    }
    const fullWithMetadataEntry = { ...sampleManifest(), namespaces: [metadataOnly] };
    expect(
      isMongoShieldError(
        errorFrom(() => parseManifest(JSON.stringify(fullWithMetadataEntry))),
        "MS_MANIFEST_INVALID",
      ),
    ).toBe(true);
  });

  it("refuses a chain on a full backup, and reads a full backup written as version 2", () => {
    const chained = { ...sampleManifest(), chain: { base: "x", parent: "x", length: 1 } };
    expect(
      isMongoShieldError(
        errorFrom(() => parseManifest(JSON.stringify(chained))),
        "MS_MANIFEST_INVALID",
      ),
    ).toBe(true);
    const versionTwo = { ...sampleManifest(), formatVersion: 2 };
    expect(parseManifest(JSON.stringify(versionTwo)).formatVersion).toBe(2);
  });
});

describe("parseManifest", () => {
  it("rejects text that is not JSON with MS_MANIFEST_INVALID", () => {
    const error = errorFrom(() => parseManifest("{", "s3://bucket/manifest.json"));
    expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    expect((error as Error).message).toContain("s3://bucket/manifest.json is not valid JSON");
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["an empty object", "{}"],
  ])("rejects %s with MS_MANIFEST_INVALID", (_label, text) => {
    expect(
      isMongoShieldError(
        errorFrom(() => parseManifest(text)),
        "MS_MANIFEST_INVALID",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "a bad sha256",
      {
        namespaces: [
          { ...sampleManifest().namespaces[0], metadata: { key: "k", size: 1, sha256: "ABC" } },
        ],
      },
    ],
    ["a negative size", { totals: { namespaces: 0, documents: -1, bytesRaw: 0, bytesStored: 0 } }],
    ["an unknown compression", { compression: "lz4" }],
    ["an incomplete status", { status: "running" }],
    ["a malformed id", { id: "2026-11-14" }],
    ["a date without a time zone", { startedAt: "2026-11-14T03:00:04" }],
    ["an encryption scheme from elsewhere", { encryption: { scheme: "gpg", recipients: ["x"] } }],
    ["no recipients", { encryption: { scheme: "age-v1", recipients: [] } }],
  ])("rejects a manifest with %s, naming the problem", (_label, overrides) => {
    const text = JSON.stringify({ ...sampleManifest(), ...overrides });
    const error = errorFrom(() => parseManifest(text));
    expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    expect((error as Error).message).toContain("does not match the manifest schema");
  });

  it("asks for an upgrade when the manifest comes from a newer format version", () => {
    const text = JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION + 1, somethingNew: true });
    const error = errorFrom(() => parseManifest(text));
    expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/Upgrade mongoshield/);
  });

  it.each([0, "1", null])(
    "treats formatVersion %j as invalid, not unsupported",
    (formatVersion) => {
      const text = JSON.stringify({ ...sampleManifest(), formatVersion });
      expect(
        isMongoShieldError(
          errorFrom(() => parseManifest(text)),
          "MS_MANIFEST_INVALID",
        ),
      ).toBe(true);
    },
  );

  it("drops unknown fields", () => {
    const text = JSON.stringify({ ...sampleManifest(), extra: 1 });
    expect(parseManifest(text)).not.toHaveProperty("extra");
  });
});

describe("readManifest and writeManifest", () => {
  it("write the manifest to backups/<id>/manifest.json and read it back", async () => {
    const storage = memoryStorage();
    const manifest = sampleManifest();
    await writeManifest(storage, manifest);
    expect(storage.keys()).toEqual([manifestKey(manifest.id)]);
    expect(await readManifest(storage, manifest.id)).toEqual(manifest);
  });

  it("return undefined for a backup without a manifest", async () => {
    expect(await readManifest(memoryStorage(), "2026-11-14T03-00-04Z_000000")).toBeUndefined();
  });

  it("never overwrite an existing manifest", async () => {
    const storage = memoryStorage();
    await writeManifest(storage, sampleManifest());
    let caught: unknown;
    try {
      await writeManifest(storage, sampleManifest({ labels: {} }));
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
    expect((await readManifest(storage, sampleManifest().id))?.labels).toEqual({ env: "prod" });
  });

  it("only ask for a conditional write when the storage supports it", async () => {
    const seen: (PutOptions | undefined)[] = [];
    const base = memoryStorage();
    const recording = (conditionalWrites: boolean): StorageAdapter => ({
      ...base,
      capabilities: { ...base.capabilities, conditionalWrites },
      put: (key: string, body: Readable | Uint8Array, options?: PutOptions) => {
        seen.push(options);
        return base.put(key, body, {});
      },
    });

    await writeManifest(recording(true), sampleManifest());
    await writeManifest(recording(false), sampleManifest());
    expect(seen[0]).toMatchObject({ ifNoneMatch: "*", contentType: "application/json" });
    expect(seen[1]).not.toHaveProperty("ifNoneMatch");
  });

  it("report a corrupt manifest with its location", async () => {
    const storage = memoryStorage({ name: "test" });
    const id = "2026-11-14T03-00-04Z_7f3a9c";
    await storage.put(manifestKey(id), Readable.from([Buffer.from("not json")]));
    let caught: unknown;
    try {
      await readManifest(storage, id);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_MANIFEST_INVALID")).toBe(true);
    expect((caught as Error).message).toContain(`memory://test/${manifestKey(id)}`);
  });

  it("stop when the signal is aborted", async () => {
    const storage = memoryStorage();
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await writeManifest(storage, sampleManifest(), { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_ABORTED")).toBe(true);
    expect(storage.keys()).toEqual([]);
  });
});

describe("immutableUntil (immutable backups)", () => {
  it("round-trips an ISO date and rejects anything else", () => {
    const manifest = sampleManifest({ immutableUntil: "2026-12-14T03:01:10.000Z" });
    expect(parseManifest(serializeManifest(manifest)).immutableUntil).toBe(
      "2026-12-14T03:01:10.000Z",
    );
    const text = serializeManifest(sampleManifest()).replace(
      '"formatVersion"',
      '"immutableUntil": "next tuesday",\n  "formatVersion"',
    );
    expect(() => parseManifest(text)).toThrow(
      expect.objectContaining({ code: "MS_MANIFEST_INVALID" }),
    );
  });

  it("writeManifest passes retainUntil to the storage so the manifest is locked too", async () => {
    const storage = memoryStorage({ objectLock: true });
    const retainUntil = new Date(Date.now() + 60_000);
    const manifest = sampleManifest({ immutableUntil: retainUntil.toISOString() });
    await writeManifest(storage, manifest, { retainUntil });
    expect(storage.retainUntilOf(manifestKey(manifest.id))).toEqual(retainUntil);
  });
});
