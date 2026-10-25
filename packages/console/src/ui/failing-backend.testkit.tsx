/**
 * Test support for the UI's error paths: renders the console against the mock backend,
 * but lets a test make chosen requests fail with an HTTP error (or never reach the
 * server), so pages can be checked for their error notices, toasts and retry buttons.
 * A rule with a 2xx status answers with a canned body instead, for responses the mock
 * never produces (documents without `_id`, say).
 *
 * Used only by `*.test.tsx` files; nothing here reaches the bundle. It mirrors
 * `renderApp` in testing.tsx (whose cleanup it reuses by importing it).
 */

import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ApiClient, type FetchLike } from "./api.ts";
import { App } from "./app.tsx";
import { createMockBackend } from "./mock/backend.ts";
import type { RenderAppOptions, RenderedApp } from "./testing.tsx";
// For its side effect: testing.tsx registers the cleanup that unmounts after each test.
import "./testing.tsx";

/** One request to fail: method + a path prefix or pattern, answered with `status`. */
export interface FailureRule {
  readonly method: string;
  /** A path prefix such as `/api/storage`, or a pattern matched against the URL. */
  readonly path: string | RegExp;
  /** HTTP status to answer with; `"network"` throws instead (no response at all). */
  readonly status: number | "network";
  readonly code?: string;
  readonly message?: string;
  readonly hint?: string;
  /** With a 2xx `status`: the JSON body to answer with instead of an error. */
  readonly body?: unknown;
  /** Fail only this many times, then pass through. Default: always. */
  readonly times?: number;
}

/** True when the rule applies to this request. */
function matches(rule: FailureRule, method: string, url: string): boolean {
  if (rule.method !== method) return false;
  const path = new URL(url, "http://mock.local").pathname;
  return typeof rule.path === "string" ? path.startsWith(rule.path) : rule.path.test(url);
}

/** Wraps a fetch so that requests matching a rule fail as the rule says. */
export function failingFetch(inner: FetchLike, rules: readonly FailureRule[]): FetchLike {
  const used = rules.map(() => 0);
  return async (url, init) => {
    const index = rules.findIndex(
      (rule, position) =>
        matches(rule, init.method, url) &&
        (rule.times === undefined || (used[position] ?? 0) < rule.times),
    );
    const rule = rules[index];
    if (rule === undefined) return inner(url, init);
    used[index] = (used[index] ?? 0) + 1;
    if (rule.status === "network") throw new TypeError("Failed to fetch");
    if (rule.status < 300) {
      const text = JSON.stringify(rule.body);
      return { status: rule.status, text: async () => text };
    }
    const body = JSON.stringify({
      error: {
        code: rule.code ?? "CONSOLE_INTERNAL",
        message: rule.message ?? "The mock was told to fail.",
        ...(rule.hint === undefined ? {} : { hint: rule.hint }),
      },
    });
    return { status: rule.status, text: async () => body };
  };
}

/** Like `renderApp`, but requests matching `failures` fail. */
export function renderFailingApp(
  options: RenderAppOptions & { readonly failures: readonly FailureRule[] },
): RenderedApp {
  const { hash, prepare, openEventSource, failures, ...backendOptions } = options;
  const backend = createMockBackend({ jobTickMs: 0, ...backendOptions });
  prepare?.(backend);
  const client = new ApiClient({
    fetch: failingFetch(backend.fetch, failures),
    openEventSource: openEventSource ?? backend.openEventSource,
  });
  window.location.hash = hash ?? "";
  const user = userEvent.setup();
  const result = render(<App client={client} />);
  return { ...result, backend, client, user };
}
