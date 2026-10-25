/**
 * Test-only, in-memory OpenTelemetry providers: a tracer provider that keeps every
 * span it starts, and a meter provider that keeps every counter and histogram
 * point. Registered globally (like a real SDK) by the telemetry tests, so the code
 * under test goes through the real `@opentelemetry/api` registry. Not exported
 * from the package.
 */

import {
  type Attributes,
  INVALID_SPAN_CONTEXT,
  type MeterProvider,
  metrics,
  type Span,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";

/** One span as recorded by the fake tracer. */
export interface RecordedSpan {
  readonly name: string;
  attributes: Attributes;
  status: SpanStatus;
  ended: boolean;
  exceptions: unknown[];
}

/** One metric point as recorded by the fake meter. */
export interface RecordedPoint {
  readonly instrument: string;
  readonly kind: "counter" | "histogram";
  readonly value: number;
  readonly attributes: Attributes;
}

/** A span that writes everything into a `RecordedSpan`. */
function fakeSpan(record: RecordedSpan, failOnAttributes: boolean): Span {
  const span: Span = {
    spanContext: () => INVALID_SPAN_CONTEXT,
    setAttribute: (key, value) => {
      if (value !== undefined) record.attributes = { ...record.attributes, [key]: value };
      return span;
    },
    setAttributes: (attributes) => {
      if (failOnAttributes) throw new Error("exporter exploded");
      record.attributes = { ...record.attributes, ...attributes };
      return span;
    },
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: (status) => {
      record.status = status;
      return span;
    },
    updateName: () => span,
    end: () => {
      record.ended = true;
    },
    isRecording: () => true,
    recordException: (exception) => {
      record.exceptions.push(exception);
    },
  };
  return span;
}

/** An in-memory tracer provider plus the spans it recorded. */
export interface FakeTracing {
  readonly provider: TracerProvider;
  readonly spans: RecordedSpan[];
}

/**
 * Creates a fake tracer provider. With `failOnAttributes`, `span.setAttributes`
 * throws, to prove that a broken exporter never fails an operation.
 */
export function createFakeTracing(options: { failOnAttributes?: boolean } = {}): FakeTracing {
  const spans: RecordedSpan[] = [];
  const startSpan = (name: string, spanOptions: SpanOptions = {}): Span => {
    const record: RecordedSpan = {
      name,
      attributes: { ...spanOptions.attributes },
      status: { code: SpanStatusCode.UNSET },
      ended: false,
      exceptions: [],
    };
    spans.push(record);
    return fakeSpan(record, options.failOnAttributes === true);
  };
  // startActiveSpan has four overloads; the callback is always the last argument.
  const startActiveSpan = (name: string, ...rest: unknown[]): unknown => {
    const callback = rest.at(-1) as (span: Span) => unknown;
    const spanOptions = typeof rest[0] === "object" ? (rest[0] as SpanOptions) : {};
    return callback(startSpan(name, spanOptions));
  };
  const tracer = { startSpan, startActiveSpan } as unknown as Tracer;
  return { provider: { getTracer: () => tracer }, spans };
}

/** An in-memory meter provider plus the points it recorded. */
export interface FakeMetrics {
  readonly provider: MeterProvider;
  readonly points: RecordedPoint[];
}

/** Creates a fake meter provider that records counter and histogram points. */
export function createFakeMetrics(): FakeMetrics {
  const points: RecordedPoint[] = [];
  const meter = {
    createCounter: (instrument: string) => ({
      add: (value: number, attributes: Attributes = {}) =>
        points.push({ instrument, kind: "counter", value, attributes }),
    }),
    createHistogram: (instrument: string) => ({
      record: (value: number, attributes: Attributes = {}) =>
        points.push({ instrument, kind: "histogram", value, attributes }),
    }),
  };
  return { provider: { getMeter: () => meter } as unknown as MeterProvider, points };
}

/** Registers fakes as the global providers, like an application's SDK setup would. */
export function registerFakes(tracing: FakeTracing, metering: FakeMetrics): void {
  trace.setGlobalTracerProvider(tracing.provider);
  metrics.setGlobalMeterProvider(metering.provider);
}

/** Unregisters every global provider (the API allows one registration per provider kind). */
export function unregisterFakes(): void {
  trace.disable();
  metrics.disable();
}
