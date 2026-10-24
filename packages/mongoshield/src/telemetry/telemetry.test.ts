// Telemetry against in-memory tracer and meter providers registered through the
// real @opentelemetry/api, as an application's SDK would register its own.

import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeManifest } from "../catalog/test-fixtures.ts";
import type { DrillReport } from "../engine/drill.ts";
import { MongoShieldError } from "../errors.ts";
import { MongoShield } from "../shield.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { BackupResult, VerifyReport } from "../types.ts";
import { withEngineSpan } from "./engine-spans.ts";
import { loadOpenTelemetryApi } from "./load-api.ts";
import { ATTRIBUTES, ENGINE_SPANS, METRICS } from "./names.ts";
import { traceBackup, traceDrill, traceVerify } from "./operations.ts";
import { Telemetry } from "./telemetry.ts";
import {
  createFakeMetrics,
  createFakeTracing,
  type FakeMetrics,
  type FakeTracing,
  registerFakes,
  unregisterFakes,
} from "./test-fakes.ts";

afterEach(() => {
  unregisterFakes();
});

/** Registers fresh fakes and returns them. */
function setUp(options: { failOnAttributes?: boolean } = {}): {
  tracing: FakeTracing;
  metering: FakeMetrics;
} {
  const tracing = createFakeTracing(options);
  const metering = createFakeMetrics();
  registerFakes(tracing, metering);
  return { tracing, metering };
}

const completedBackup: BackupResult = {
  status: "complete",
  id: "2026-10-20T03-00-00Z_abcdef",
  durationMs: 1200,
  manifest: makeManifest("2026-10-20T03-00-00Z_abcdef", {
    namespaces: [
      {
        ns: "app.users",
        db: "app",
        collection: "users",
        type: "collection",
        documents: 10,
        bytesRaw: 1000,
        files: [],
        metadata: { key: "app/users.metadata.json", size: 1, sha256: "0".repeat(64) },
      },
    ],
    totals: { namespaces: 1, documents: 10, bytesRaw: 1000, bytesStored: 400 },
  }),
};

describe("Telemetry.withSpan", () => {
  it("runs the function without creating spans when no tracer provider is registered", async () => {
    const telemetry = new Telemetry();
    await expect(telemetry.withSpan("mongoshield.test", {}, async () => 42)).resolves.toBe(42);
  });

  it("records a named span with its attributes and ends it", async () => {
    const { tracing } = setUp();
    const telemetry = new Telemetry();
    const result = await telemetry.withSpan(
      "mongoshield.test",
      { a: 1, skipped: undefined },
      async (span) => {
        span.setAttributes({ b: "two", list: ["x", "y"] });
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(tracing.spans).toEqual([
      expect.objectContaining({
        name: "mongoshield.test",
        attributes: { a: 1, b: "two", list: ["x", "y"] },
        status: { code: SpanStatusCode.UNSET },
        ended: true,
      }),
    ]);
  });

  it("marks a failed span with the error code only, and rethrows the same error", async () => {
    const { tracing } = setUp();
    const error = new MongoShieldError(
      "MS_AUTH_FAILED",
      "user alice could not log in to db.example.com",
    );
    const telemetry = new Telemetry();
    await expect(
      telemetry.withSpan("mongoshield.test", {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const [span] = tracing.spans;
    expect(span?.attributes[ATTRIBUTES.errorType]).toBe("MS_AUTH_FAILED");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "MS_AUTH_FAILED" });
    expect(span?.ended).toBe(true);
    // Messages may name hosts, users or namespaces: they never reach the span.
    expect(JSON.stringify(span)).not.toContain("alice");
  });

  it("never fails an operation because the telemetry pipeline throws", async () => {
    setUp({ failOnAttributes: true });
    const telemetry = new Telemetry();
    const result = await telemetry.withSpan("mongoshield.test", {}, async (span) => {
      span.setAttributes({ a: 1 });
      return "still fine";
    });
    expect(result).toBe("still fine");
  });

  it("never loads the API when telemetry is disabled", async () => {
    const load = vi.fn(loadOpenTelemetryApi);
    const telemetry = new Telemetry({ enabled: false }, load);
    await telemetry.withSpan("mongoshield.test", {}, async () => undefined);
    await telemetry.count("documents", 1, {});
    expect(load).not.toHaveBeenCalled();
  });

  it("runs the function directly when the API cannot be loaded", async () => {
    const { tracing, metering } = setUp();
    const telemetry = new Telemetry({}, async () => undefined);
    await expect(telemetry.withSpan("mongoshield.test", {}, async () => 7)).resolves.toBe(7);
    await telemetry.count("documents", 3, {});
    expect(tracing.spans).toEqual([]);
    expect(metering.points).toEqual([]);
  });

  it("treats a loader that throws as 'not installed'", async () => {
    const telemetry = new Telemetry({}, () => Promise.reject(new Error("broken install")));
    await expect(telemetry.withSpan("mongoshield.test", {}, async () => 1)).resolves.toBe(1);
  });
});

describe("Telemetry metrics", () => {
  it("records counters and durations in seconds, ignoring invalid values", async () => {
    const { metering } = setUp();
    const telemetry = new Telemetry();
    await telemetry.count("documents", 5, { [ATTRIBUTES.operation]: "backup" });
    await telemetry.count("documents", -1, {});
    await telemetry.count("documents", Number.NaN, {});
    await telemetry.recordDuration("backupDuration", 1500, {});
    expect(metering.points).toEqual([
      {
        instrument: METRICS.documents.name,
        kind: "counter",
        value: 5,
        attributes: { [ATTRIBUTES.operation]: "backup" },
      },
      { instrument: METRICS.backupDuration.name, kind: "histogram", value: 1.5, attributes: {} },
    ]);
  });

  it("starts recording once the application registers a meter provider after first use", async () => {
    const telemetry = new Telemetry();
    await telemetry.count("documents", 1, {});
    const { metering } = setUp();
    await telemetry.count("documents", 2, {});
    expect(metering.points.map((point) => point.value)).toEqual([2]);
  });

  it("names a namespace only when includeNamespaces is on", () => {
    expect(new Telemetry().namespaceAttributes("app.users")).toEqual({});
    expect(new Telemetry({ includeNamespaces: true }).namespaceAttributes("app.users")).toEqual({
      [ATTRIBUTES.namespace]: "app.users",
    });
  });
});

describe("operation tracing", () => {
  it("records a completed backup's span and metrics without namespace names by default", async () => {
    const { tracing, metering } = setUp();
    await traceBackup(new Telemetry(), async () => completedBackup);

    expect(tracing.spans[0]).toMatchObject({
      name: "mongoshield.backup",
      attributes: {
        [ATTRIBUTES.backupId]: completedBackup.id,
        [ATTRIBUTES.backupStatus]: "complete",
        [ATTRIBUTES.documents]: 10,
        [ATTRIBUTES.bytesStored]: 400,
        [ATTRIBUTES.namespaceCount]: 1,
      },
    });
    expect(JSON.stringify(tracing.spans)).not.toContain("app.users");
    expect(metering.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instrument: METRICS.backups.name,
          value: 1,
          attributes: { [ATTRIBUTES.status]: "success" },
        }),
        expect.objectContaining({ instrument: METRICS.backupDuration.name, kind: "histogram" }),
        expect.objectContaining({ instrument: METRICS.documents.name, value: 10 }),
        expect.objectContaining({
          instrument: METRICS.bytes.name,
          value: 400,
          attributes: { [ATTRIBUTES.operation]: "backup", [ATTRIBUTES.bytesKind]: "stored" },
        }),
      ]),
    );
  });

  it("reports namespace names when includeNamespaces is on", async () => {
    const { tracing } = setUp();
    await traceBackup(new Telemetry({ includeNamespaces: true }), async () => completedBackup);
    expect(tracing.spans[0]?.attributes[ATTRIBUTES.namespaceNames]).toEqual(["app.users"]);
  });

  it("counts a failed backup by status and error code", async () => {
    const { tracing, metering } = setUp();
    const failure = new MongoShieldError("MS_CONNECTION_FAILED", "no route");
    await expect(
      traceBackup(new Telemetry(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(tracing.spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(metering.points).toContainEqual({
      instrument: METRICS.backups.name,
      kind: "counter",
      value: 1,
      attributes: {
        [ATTRIBUTES.status]: "failure",
        [ATTRIBUTES.errorType]: "MS_CONNECTION_FAILED",
      },
    });
  });

  it("counts a checkpointed backup without counting its documents yet", async () => {
    const { metering } = setUp();
    await traceBackup(new Telemetry(), async () => ({
      status: "checkpointed",
      id: completedBackup.id,
      durationMs: 10,
      checkpoint: { key: "k", partsDone: 1, partsTotal: 3, documents: 50, bytesRaw: 500 },
    }));
    expect(metering.points).toContainEqual(
      expect.objectContaining({
        instrument: METRICS.backups.name,
        attributes: { [ATTRIBUTES.status]: "checkpointed" },
      }),
    );
    expect(metering.points.some((point) => point.instrument === METRICS.documents.name)).toBe(
      false,
    );
  });

  it("marks a verification with problems as failed without throwing", async () => {
    const { tracing } = setUp();
    const report: VerifyReport = {
      backupId: completedBackup.id,
      mode: "fast",
      ok: false,
      filesChecked: 2,
      bytesChecked: 100,
      documentsChecked: 0,
      problems: [{ subject: "app/users.bson.zst", problem: "SHA-256 differs" }],
      durationMs: 5,
    };
    await expect(traceVerify(new Telemetry(), "fast", async () => report)).resolves.toBe(report);
    expect(tracing.spans[0]).toMatchObject({
      name: "mongoshield.verify",
      attributes: { [ATTRIBUTES.ok]: false, [ATTRIBUTES.problems]: 1, [ATTRIBUTES.mode]: "fast" },
      status: { code: SpanStatusCode.ERROR, message: "MS_INTEGRITY_FAILED" },
    });
  });

  it("records a drill's RTO on the span and the restore-duration histogram", async () => {
    const { tracing, metering } = setUp();
    const report: DrillReport = {
      backupId: completedBackup.id,
      ok: true,
      startedAt: new Date().toISOString(),
      durationMs: 9000,
      restoreDurationMs: 4000,
      restored: true,
      documentsRestored: 10,
      databases: [{ source: "app", target: "msdrill_00000000_app" }],
      kept: false,
      namespaces: [],
      problems: [],
      warnings: [],
    };
    await traceDrill(new Telemetry(), async () => report);
    expect(tracing.spans[0]?.attributes[ATTRIBUTES.rtoMs]).toBe(4000);
    expect(metering.points).toContainEqual({
      instrument: METRICS.restoreDuration.name,
      kind: "histogram",
      value: 4,
      attributes: { [ATTRIBUTES.status]: "success", [ATTRIBUTES.drill]: true },
    });
  });

  it("wraps the public API of MongoShield (prune, verify)", async () => {
    const { tracing } = setUp();
    const shield = new MongoShield({ storage: memoryStorage() });
    await shield.prune({ last: 1 });
    await expect(shield.verify({ backup: "latest" })).rejects.toMatchObject({
      code: "MS_BACKUP_NOT_FOUND",
    });
    expect(tracing.spans.map((span) => [span.name, span.attributes[ATTRIBUTES.errorType]])).toEqual(
      [
        ["mongoshield.prune", undefined],
        ["mongoshield.verify", "MS_BACKUP_NOT_FOUND"],
      ],
    );
  });

  it("records nothing when the shield is created with telemetry disabled", async () => {
    const { tracing } = setUp();
    const shield = new MongoShield({ storage: memoryStorage(), telemetry: { enabled: false } });
    await shield.prune({ last: 1 });
    expect(tracing.spans).toEqual([]);
  });
});

describe("withEngineSpan", () => {
  it("runs the work directly, without building attributes, when there is no telemetry", async () => {
    const { tracing } = setUp();
    const attributes = vi.fn(() => ({}));
    const result = await withEngineSpan(
      undefined,
      ENGINE_SPANS.verifyNamespace,
      attributes,
      async (span) => {
        span.setAttributes({ [ATTRIBUTES.problems]: 1 });
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(attributes).not.toHaveBeenCalled();
    expect(tracing.spans).toEqual([]);
  });

  it("opens the named span with the namespace only when includeNamespaces is on", async () => {
    const { tracing } = setUp();
    for (const includeNamespaces of [false, true]) {
      const telemetry = new Telemetry({ includeNamespaces });
      await withEngineSpan(
        telemetry,
        ENGINE_SPANS.backupNamespace,
        (current) => current.namespaceAttributes("app.users"),
        async () => undefined,
      );
    }
    expect(tracing.spans.map((span) => [span.name, span.attributes[ATTRIBUTES.namespace]])).toEqual(
      [
        ["mongoshield.backup.namespace", undefined],
        ["mongoshield.backup.namespace", "app.users"],
      ],
    );
  });

  it("marks the span failed with the error code and rethrows", async () => {
    const { tracing } = setUp();
    const failure = new MongoShieldError("MS_RESTORE_FAILED", "insert failed");
    await expect(
      withEngineSpan(
        new Telemetry(),
        ENGINE_SPANS.restoreNamespace,
        () => ({}),
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(tracing.spans[0]?.attributes[ATTRIBUTES.errorType]).toBe("MS_RESTORE_FAILED");
    expect(tracing.spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
