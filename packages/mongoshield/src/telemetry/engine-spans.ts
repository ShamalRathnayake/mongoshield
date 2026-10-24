/**
 * Engine-internal spans: one per namespace (and one for a change replay) inside
 * the operation span that `MongoShield` opens (operations.ts).
 *
 * The engines receive telemetry through their context (`EngineContext.telemetry`)
 * and wrap each unit of work in `withEngineSpan`. Without telemetry (engines
 * called directly, or `telemetry: { enabled: false }`) the work runs directly:
 * not even a promise is added per namespace.
 */

import type { EngineSpanName } from "./names.ts";
import type { SpanScope, Telemetry, TelemetryAttributes } from "./telemetry.ts";

/** Handed to the work when nothing is recorded; every method does nothing. */
const NO_SPAN: SpanScope = { setAttributes: () => {}, fail: () => {} };

/**
 * Runs `run` inside the engine span `name` (see `ENGINE_SPANS`), or directly when
 * `telemetry` is undefined. Errors mark the span failed and are rethrown unchanged.
 *
 * @param attributes builds the start attributes (called only when recording). Name
 *   namespaces with `telemetry.namespaceAttributes(ns)`, which respects `includeNamespaces`.
 */
export function withEngineSpan<T>(
  telemetry: Telemetry | undefined,
  name: EngineSpanName,
  attributes: (telemetry: Telemetry) => TelemetryAttributes,
  run: (span: SpanScope) => Promise<T>,
): Promise<T> {
  if (telemetry === undefined) return run(NO_SPAN);
  return telemetry.withSpan(name, attributes(telemetry), run);
}
