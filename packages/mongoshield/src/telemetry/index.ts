/**
 * OpenTelemetry support: optional spans and metrics for every public operation.
 * See telemetry.ts for the guarantees (zero cost when unused, nothing secret
 * recorded) and docs/guides/observability.md for the user-facing list.
 */

export { withEngineSpan } from "./engine-spans.ts";
export { loadOpenTelemetryApi, type OpenTelemetryLoader } from "./load-api.ts";
export {
  ATTRIBUTES,
  ENGINE_SPANS,
  type EngineSpanName,
  INSTRUMENTATION_SCOPE,
  METRICS,
  spanName,
  type TracedOperation,
} from "./names.ts";
export { traceBackup, traceDrill, tracePrune, traceRestore, traceVerify } from "./operations.ts";
export {
  type CounterName,
  errorTypeOf,
  type HistogramName,
  type SpanScope,
  Telemetry,
  type TelemetryAttributes,
} from "./telemetry.ts";
