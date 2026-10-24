/**
 * Test helpers for the UI tests (Vitest + Testing Library, jsdom). Never imported by
 * the app itself, so none of this reaches the bundle.
 *
 * `renderApp()` mounts the whole console against a fresh mock backend at a given hash
 * route, optionally signed in, and returns the backend so tests can inspect requests and
 * data. Page tests go through the real router, client and session handling this way.
 */

import { cleanup, type RenderResult, render } from "@testing-library/react";
import { type UserEvent, userEvent } from "@testing-library/user-event";
import { afterEach } from "vitest";
import { ApiClient, type EventSourceFactory } from "./api.ts";
import { App } from "./app.tsx";
import { createMockBackend, type MockBackend, type MockBackendOptions } from "./mock/backend.ts";

/** Backends created by the current test, stopped after it. */
const liveBackends: MockBackend[] = [];

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  for (const backend of liveBackends.splice(0)) backend.dispose();
  window.location.hash = "";
});

/** What `renderApp` returns. */
export interface RenderedApp extends RenderResult {
  readonly backend: MockBackend;
  readonly client: ApiClient;
  readonly user: UserEvent;
}

/** Options for `renderApp`: mock backend options plus test hooks. */
export interface RenderAppOptions extends MockBackendOptions {
  /** Initial hash route, e.g. `#/plans/new`. */
  readonly hash?: string;
  /** Changes the mock data before the app loads. */
  readonly prepare?: (backend: MockBackend) => void;
  /** Replaces the mock's job event streams, to drive SSE by hand. */
  readonly openEventSource?: EventSourceFactory;
}

/**
 * Renders the console at `hash` (e.g. `#/plans/new`) with a fresh mock backend.
 * Jobs do not progress on their own (`jobTickMs: 0`) unless a test asks for it.
 */
export function renderApp(options: RenderAppOptions = {}): RenderedApp {
  const { hash, prepare, openEventSource, ...backendOptions } = options;
  const backend = createMockBackend({ jobTickMs: 0, ...backendOptions });
  prepare?.(backend);
  const client = new ApiClient({
    fetch: backend.fetch,
    openEventSource: openEventSource ?? backend.openEventSource,
  });
  window.location.hash = hash ?? "";
  const user = userEvent.setup();
  const result = render(<App client={client} />);
  liveBackends.push(backend);
  return { ...result, backend, client, user };
}

/** The requests the mock received for one method + path prefix, e.g. ("POST", "/api/plans"). */
export function requestsTo(
  backend: MockBackend,
  method: string,
  pathPrefix: string,
): MockBackend["requests"] {
  return backend.requests.filter(
    (request) => request.method === method && request.url.startsWith(pathPrefix),
  );
}
