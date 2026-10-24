/**
 * Browser entry point: picks the real server or the in-memory mock, applies the saved
 * theme and mounts the app.
 *
 * Mock mode (`?mock=1` in the page URL) loads src/ui/mock lazily, so the mock code and its
 * fixtures are a separate chunk that a normal session never downloads.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient } from "./api.ts";
import { App } from "./app.tsx";
import "./styles.css";
import { applyTheme, storedTheme } from "./theme.ts";

/** True when the page was opened with `?mock=1`. */
function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

async function createClient(): Promise<ApiClient> {
  if (!isMockMode()) return new ApiClient();
  const { createMockBackend } = await import("./mock/backend.ts");
  // `?mock=1&setup=1` starts before setup, to try the setup page with token "mock-setup-token".
  const startBeforeSetup = new URLSearchParams(window.location.search).get("setup") === "1";
  const backend = createMockBackend({ latencyMs: 120, setupComplete: !startBeforeSetup });
  return new ApiClient({ fetch: backend.fetch, openEventSource: backend.openEventSource });
}

async function start(): Promise<void> {
  applyTheme(storedTheme());
  const root = document.getElementById("root");
  if (root === null) throw new Error('index.html is missing <div id="root">.');
  const client = await createClient();
  createRoot(root).render(
    <StrictMode>
      <App client={client} mock={isMockMode()} />
    </StrictMode>,
  );
}

void start();
