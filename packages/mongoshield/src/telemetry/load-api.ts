/**
 * Loading `@opentelemetry/api`, lazily and at most once.
 *
 * The API is an optional peer dependency: most users never install it, and
 * MongoShield must work exactly the same without it. So it is never imported at
 * the top of a module (that would make it a hard dependency of the bundle);
 * the first traced operation imports it, and the outcome (the module, or
 * "not installed") is cached for the life of the process.
 *
 * Only the API package is ever loaded. The SDK (exporters, processors, the
 * context manager) is the application's choice and is registered globally by
 * the application; the API finds it through its global registry, even when the
 * application and MongoShield resolved different copies of the API.
 */

import type * as OpenTelemetryApi from "@opentelemetry/api";

/** The `@opentelemetry/api` module, as seen by the rest of `src/telemetry`. */
export type OpenTelemetryModule = typeof OpenTelemetryApi;

/** Loads the API module; resolves to `undefined` when it is not installed. */
export type OpenTelemetryLoader = () => Promise<OpenTelemetryModule | undefined>;

/** The cached result of the one import attempt (a promise, so concurrent callers share it). */
let cached: Promise<OpenTelemetryModule | undefined> | undefined;

/**
 * Imports `@opentelemetry/api` on first use. Any failure (not installed, broken
 * install) means "no telemetry": tracing must never be the reason a backup fails.
 */
export const loadOpenTelemetryApi: OpenTelemetryLoader = () => {
  cached ??= importApi();
  return cached;
};

async function importApi(): Promise<OpenTelemetryModule | undefined> {
  try {
    // Peer dependencies are external to the bundle, so this stays a runtime import.
    return await import("@opentelemetry/api");
  } catch {
    return undefined;
  }
}
