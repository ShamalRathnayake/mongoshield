/**
 * Global setup for the opt-in cloud tests (`pnpm test:cloud`).
 *
 * The end-to-end tests need a real mongod, so this starts the same single-node
 * replica set as the integration tests (test/helpers/global-setup.ts). But only
 * when at least one cloud target is configured: with no cloud variables set, every
 * suite skips, and starting (or downloading) mongod would only waste time.
 */

import type { TestProject } from "vitest/node";
import * as integrationSetup from "../helpers/global-setup.ts";
import { anyCloudTargetConfigured } from "./env.ts";

/** Whether `setup` started the replica set, so `teardown` knows to stop it. */
let started = false;

export async function setup(project: TestProject): Promise<void> {
  if (!anyCloudTargetConfigured()) {
    // Nothing will run; tests read the URI only inside suites that are skipped.
    project.provide("mongoUri", "");
    return;
  }
  await integrationSetup.setup(project);
  started = true;
}

export async function teardown(): Promise<void> {
  if (started) await integrationSetup.teardown();
}
