/**
 * `Telemetry`: MongoShield's thin, optional bridge to OpenTelemetry.
 *
 * Two promises shape this file:
 *
 * 1. **Zero cost when unused.** With `telemetry: { enabled: false }` the API is
 *    never imported. When `@opentelemetry/api` is not installed, the one failed
 *    import is cached and every call runs the wrapped function directly. When the
 *    API is installed but the application registered no tracer provider, no span
 *    objects are created at all (the global provider is an empty proxy then).
 *    Metric instruments without a registered meter provider are the API's no-ops.
 *
 * 2. **Never the reason an operation fails, never a leak.** Errors raised by the
 *    telemetry pipeline itself are swallowed. Spans and metrics carry ids, counts,
 *    sizes, durations and error codes only: never connection strings, keys,
 *    document contents or error messages (messages may quote namespace names or
 *    paths). Namespace names are reported only with `includeNamespaces: true`.
 *
 * The operation-specific wrappers (what a backup span records, …) live in
 * `operations.ts`; this file only knows spans, counters and histograms.
 */

import type {
  Attributes,
  Counter,
  Histogram,
  MeterProvider,
  Span,
  Tracer,
} from "@opentelemetry/api";
import { isMongoShieldError } from "../errors.ts";
import type { TelemetryOptions } from "../types.ts";
import { version } from "../version.ts";
import {
  loadOpenTelemetryApi,
  type OpenTelemetryLoader,
  type OpenTelemetryModule,
} from "./load-api.ts";
import { ATTRIBUTES, INSTRUMENTATION_SCOPE, METRICS } from "./names.ts";

/**
 * Attribute values MongoShield reports. `undefined` values are dropped, so callers
 * can write `{ [ATTRIBUTES.backupId]: result?.id }` without a conditional.
 */
export type TelemetryAttributes = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>;

/** What a traced function may do with its span. Every method is a no-op without a tracer. */
export interface SpanScope {
  /** Adds attributes to the span (e.g. totals that are known only at the end). */
  setAttributes(attributes: TelemetryAttributes): void;
  /**
   * Marks the span as failed without throwing, for outcomes that are failures but
   * not exceptions (a verification that found problems). `errorType` is an error code.
   */
  fail(errorType: string): void;
}

/** Counters MongoShield maintains. */
export type CounterName = "documents" | "bytes" | "backups";

/** Histograms MongoShield maintains (values are recorded in seconds). */
export type HistogramName = "backupDuration" | "restoreDuration";

/** The scope handed to traced functions when nothing is being recorded. */
const NOOP_SCOPE: SpanScope = { setAttributes: () => {}, fail: () => {} };

/** Metric instruments, created for one meter provider. */
interface Instruments {
  /** The provider they were created from: if the application swaps it, they are recreated. */
  readonly provider: MeterProvider;
  readonly counters: Readonly<Record<CounterName, Counter>>;
  readonly histograms: Readonly<Record<HistogramName, Histogram>>;
}

/** Converts an error into the low-cardinality `error.type` value: its code, never its message. */
export function errorTypeOf(error: unknown): string {
  if (isMongoShieldError(error)) return error.code;
  if (error instanceof Error && error.name !== "Error") return error.name;
  return "Error";
}

/**
 * The telemetry of one `MongoShield` instance. Cheap to create; does nothing
 * until the first traced call, and nothing at all when disabled.
 */
export class Telemetry {
  /** Whether namespace names may be reported (see `TelemetryOptions.includeNamespaces`). */
  readonly includeNamespaces: boolean;
  /**
   * False with `telemetry: { enabled: false }`. Callers use it to skip even the
   * cheap no-op calls in hot loops (see engine-spans.ts).
   */
  readonly enabled: boolean;

  readonly #enabled: boolean;
  readonly #load: OpenTelemetryLoader;
  #instruments: Instruments | undefined;

  /**
   * @param options the user's `telemetry` option (enabled by default).
   * @param load how to obtain the API; tests pass a stub, everyone else the lazy import.
   */
  constructor(options: TelemetryOptions = {}, load: OpenTelemetryLoader = loadOpenTelemetryApi) {
    this.#enabled = options.enabled ?? true;
    this.enabled = this.#enabled;
    this.includeNamespaces = options.includeNamespaces === true;
    this.#load = load;
  }

  /**
   * The attributes naming one namespace, for engine-internal spans: empty unless
   * `includeNamespaces` is on (namespace names can reveal customer or product names).
   */
  namespaceAttributes(ns: string): TelemetryAttributes {
    return this.includeNamespaces ? { [ATTRIBUTES.namespace]: ns } : {};
  }

  /**
   * Runs `run` inside an active span called `name`, so spans started inside it
   * (by the engines, the MongoDB driver's instrumentation, the storage SDKs) nest
   * under it. A thrown error marks the span failed with its code and is rethrown
   * unchanged. Without a tracer, `run` is simply called.
   */
  async withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    run: (span: SpanScope) => Promise<T>,
  ): Promise<T> {
    const api = await this.#api();
    const tracer = api === undefined ? undefined : registeredTracer(api);
    if (api === undefined || tracer === undefined) return run(NOOP_SCOPE);

    return tracer.startActiveSpan(
      name,
      { attributes: toOtelAttributes(attributes) },
      async (span) => {
        try {
          return await run(scopeFor(span, api));
        } catch (error) {
          safely(() => markFailed(span, api, errorTypeOf(error)));
          throw error;
        } finally {
          safely(() => span.end());
        }
      },
    );
  }

  /** Adds `value` to a counter. Negative or non-finite values are ignored. */
  async count(name: CounterName, value: number, attributes: TelemetryAttributes): Promise<void> {
    if (!Number.isFinite(value) || value < 0) return;
    const instruments = await this.#currentInstruments();
    safely(() => instruments?.counters[name].add(value, toOtelAttributes(attributes)));
  }

  /** Records a duration (given in milliseconds, recorded in seconds as OpenTelemetry advises). */
  async recordDuration(
    name: HistogramName,
    durationMs: number,
    attributes: TelemetryAttributes,
  ): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const instruments = await this.#currentInstruments();
    safely(() =>
      instruments?.histograms[name].record(durationMs / 1000, toOtelAttributes(attributes)),
    );
  }

  // -------------------------------------------------------------------------

  /** The API module, or `undefined` when disabled or not installed. */
  async #api(): Promise<OpenTelemetryModule | undefined> {
    if (!this.#enabled) return undefined;
    try {
      return await this.#load();
    } catch {
      return undefined;
    }
  }

  /**
   * Instruments for the currently registered meter provider. Unlike tracers, meters
   * have no proxy: instruments created before the application registers its
   * provider would stay no-ops forever, so they are recreated when it changes.
   */
  async #currentInstruments(): Promise<Instruments | undefined> {
    const api = await this.#api();
    if (api === undefined) return undefined;
    try {
      const provider = api.metrics.getMeterProvider();
      if (this.#instruments?.provider !== provider) {
        this.#instruments = createInstruments(provider);
      }
      return this.#instruments;
    } catch {
      return undefined;
    }
  }
}

/**
 * The tracer of the application's registered provider, or `undefined` when none
 * is registered. The global provider is always a `ProxyTracerProvider`; until an
 * SDK registers itself it has no delegate, and creating spans would be wasted work.
 */
function registeredTracer(api: OpenTelemetryModule): Tracer | undefined {
  try {
    const provider = api.trace.getTracerProvider();
    if (provider instanceof api.ProxyTracerProvider) {
      return provider.getDelegateTracer(INSTRUMENTATION_SCOPE, version);
    }
    return provider.getTracer(INSTRUMENTATION_SCOPE, version);
  } catch {
    return undefined;
  }
}

function createInstruments(provider: MeterProvider): Instruments {
  const meter = provider.getMeter(INSTRUMENTATION_SCOPE, version);
  const counter = (spec: { name: string; unit: string; description: string }) =>
    meter.createCounter(spec.name, { unit: spec.unit, description: spec.description });
  const histogram = (spec: { name: string; unit: string; description: string }) =>
    meter.createHistogram(spec.name, { unit: spec.unit, description: spec.description });
  return {
    provider,
    counters: {
      documents: counter(METRICS.documents),
      bytes: counter(METRICS.bytes),
      backups: counter(METRICS.backups),
    },
    histograms: {
      backupDuration: histogram(METRICS.backupDuration),
      restoreDuration: histogram(METRICS.restoreDuration),
    },
  };
}

function scopeFor(span: Span, api: OpenTelemetryModule): SpanScope {
  return {
    setAttributes: (attributes) => safely(() => span.setAttributes(toOtelAttributes(attributes))),
    fail: (errorType) => safely(() => markFailed(span, api, errorType)),
  };
}

/**
 * Marks a span as failed. The status message is the error code, not the error
 * message: messages can quote namespace names, file paths or hosts.
 */
function markFailed(span: Span, api: OpenTelemetryModule, errorType: string): void {
  span.setAttribute(ATTRIBUTES.errorType, errorType);
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: errorType });
}

/** Drops `undefined` values and copies arrays (OpenTelemetry wants mutable ones). */
function toOtelAttributes(attributes: TelemetryAttributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    result[key] = typeof value === "object" ? [...value] : value;
  }
  return result;
}

/** Runs a telemetry side effect; a failing exporter or SDK must never fail an operation. */
function safely(effect: () => void): void {
  try {
    effect();
  } catch {
    // Deliberately ignored: telemetry is best effort.
  }
}
