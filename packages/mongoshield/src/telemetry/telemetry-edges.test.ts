// Telemetry edge cases: error types, tracer providers that are not the global proxy,
// API modules that throw, dry-run and not-restored operations, and the in-memory
// fakes the other telemetry tests rely on.

import * as api from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import type { DrillReport } from "../engine/drill.ts";
import { MongoShieldError } from "../errors.ts";
import type { RestoreResult } from "../types.ts";
import type { OpenTelemetryModule } from "./load-api.ts";
import { ATTRIBUTES, METRICS } from "./names.ts";
import { traceDrill, traceRestore } from "./operations.ts";
import { errorTypeOf, Telemetry } from "./telemetry.ts";
import {
  createFakeMetrics,
  createFakeTracing,
  registerFakes,
  unregisterFakes,
} from "./test-fakes.ts";

afterEach(() => {
  unregisterFakes();
});

/** The real API module with its `trace` and `metrics` entry points replaced. */
function moduleWith(overrides: {
  getTracerProvider?: () => api.TracerProvider;
  getMeterProvider?: () => api.MeterProvider;
}): OpenTelemetryModule {
  return {
    ...api,
    trace: {
      ...api.trace,
      getTracerProvider: overrides.getTracerProvider ?? (() => api.trace.getTracerProvider()),
    } as typeof api.trace,
    metrics: {
      ...api.metrics,
      getMeterProvider: overrides.getMeterProvider ?? (() => api.metrics.getMeterProvider()),
    } as typeof api.metrics,
  };
}

describe("errorTypeOf", () => {
  it("reports MongoShield codes, named error classes, and 'Error' for anything else", () => {
    expect(errorTypeOf(new MongoShieldError("MS_ABORTED", "stopped"))).toBe("MS_ABORTED");
    expect(errorTypeOf(new TypeError("bad"))).toBe("TypeError");
    expect(errorTypeOf(new Error("plain"))).toBe("Error");
    expect(errorTypeOf("a string")).toBe("Error");
  });
});

describe("Telemetry with unusual API modules", () => {
  it("uses a tracer provider that is not the global proxy directly", async () => {
    const tracing = createFakeTracing();
    const telemetry = new Telemetry({}, async () =>
      moduleWith({ getTracerProvider: () => tracing.provider }),
    );
    await expect(telemetry.withSpan("mongoshield.direct", {}, async () => 5)).resolves.toBe(5);
    expect(tracing.spans.map((span) => span.name)).toEqual(["mongoshield.direct"]);
  });

  it("runs the function untraced when asking for the tracer provider throws", async () => {
    const telemetry = new Telemetry({}, async () =>
      moduleWith({
        getTracerProvider: () => {
          throw new Error("broken global");
        },
      }),
    );
    await expect(telemetry.withSpan("mongoshield.test", {}, async () => "ok")).resolves.toBe("ok");
  });

  it("records no metrics, and does not fail, when asking for the meter provider throws", async () => {
    const telemetry = new Telemetry({}, async () =>
      moduleWith({
        getMeterProvider: () => {
          throw new Error("broken global");
        },
      }),
    );
    await expect(telemetry.count("documents", 1, {})).resolves.toBeUndefined();
    await expect(telemetry.recordDuration("backupDuration", 10, {})).resolves.toBeUndefined();
  });

  it("ignores negative and non-finite durations", async () => {
    const metering = createFakeMetrics();
    registerFakes(createFakeTracing(), metering);
    const telemetry = new Telemetry();
    await telemetry.recordDuration("backupDuration", -1, {});
    await telemetry.recordDuration("backupDuration", Number.POSITIVE_INFINITY, {});
    expect(metering.points).toEqual([]);
  });
});

describe("operation tracing edge cases", () => {
  it("records no restore duration for a failed dry run, and rethrows its error", async () => {
    const metering = createFakeMetrics();
    registerFakes(createFakeTracing(), metering);
    const error = new MongoShieldError("MS_RESTORE_FAILED", "nope");
    await expect(
      traceRestore(new Telemetry(), { mode: "drop", dryRun: true }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(metering.points).toEqual([]);
  });

  it("records the duration of a failed real restore with its error type", async () => {
    const metering = createFakeMetrics();
    registerFakes(createFakeTracing(), metering);
    await expect(
      traceRestore(new Telemetry(), { mode: "drop", dryRun: false }, async () => {
        throw new MongoShieldError("MS_RESTORE_FAILED", "nope");
      }),
    ).rejects.toThrow("nope");
    expect(metering.points).toEqual([
      expect.objectContaining({
        instrument: METRICS.restoreDuration.name,
        attributes: { [ATTRIBUTES.status]: "failure", [ATTRIBUTES.errorType]: "MS_RESTORE_FAILED" },
      }),
    ]);
  });

  it("records no restore duration for a dry-run restore that succeeds", async () => {
    const metering = createFakeMetrics();
    registerFakes(createFakeTracing(), metering);
    const result = {
      dryRun: true,
      durationMs: 5,
      documentsRestored: 0,
      plan: { backupId: "b", entries: [] },
    } as unknown as RestoreResult;
    await expect(
      traceRestore(new Telemetry(), { mode: "drop", dryRun: true }, async () => result),
    ).resolves.toBe(result);
    expect(metering.points).toEqual([]);
  });

  it("records no RTO point for a drill that never restored, and marks it failed", async () => {
    const tracing = createFakeTracing();
    const metering = createFakeMetrics();
    registerFakes(tracing, metering);
    const report: DrillReport = {
      backupId: "b",
      ok: false,
      startedAt: new Date().toISOString(),
      durationMs: 10,
      restoreDurationMs: 0,
      restored: false,
      documentsRestored: 0,
      databases: [],
      kept: false,
      namespaces: [],
      problems: [{ subject: "app", problem: "the scratch target refused" }],
      warnings: [],
    };
    await traceDrill(new Telemetry(), async () => report);
    expect(
      metering.points.filter((point) => point.instrument === METRICS.restoreDuration.name),
    ).toEqual([]);
    expect(tracing.spans[0]?.status.code).toBe(api.SpanStatusCode.ERROR);
  });
});

describe("the in-memory fakes", () => {
  it("record what a span is told, ignoring undefined attributes", () => {
    const tracing = createFakeTracing();
    const tracer = tracing.provider.getTracer("test");
    const span = tracer.startSpan("fake");
    expect(span.spanContext()).toBe(api.INVALID_SPAN_CONTEXT);
    span.setAttribute("kept", 1);
    span.setAttribute("dropped", undefined as unknown as api.AttributeValue);
    span.addEvent("event").addLink({ context: api.INVALID_SPAN_CONTEXT });
    span.addLinks([]).updateName("renamed");
    span.recordException(new Error("recorded"));
    expect(span.isRecording()).toBe(true);
    span.end();
    expect(tracing.spans[0]).toMatchObject({
      name: "fake",
      attributes: { kept: 1 },
      ended: true,
      exceptions: [expect.any(Error)],
    });
  });

  it("start an active span with or without options", () => {
    const tracing = createFakeTracing();
    const tracer = tracing.provider.getTracer("test");
    expect(tracer.startActiveSpan("plain", () => "no options")).toBe("no options");
    expect(tracer.startActiveSpan("with", { attributes: { a: 1 } }, () => "options")).toBe(
      "options",
    );
    expect(tracing.spans.map((span) => [span.name, span.attributes])).toEqual([
      ["plain", {}],
      ["with", { a: 1 }],
    ]);
  });
});
