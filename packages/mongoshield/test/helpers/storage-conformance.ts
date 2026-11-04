/**
 * The storage conformance suite, wired to Vitest for this repository's own tests.
 *
 * The suite itself is the published contract test kit (`mongoshield/testing/storage`,
 * src/testing/storage-conformance.ts), which takes the test framework's functions as a
 * parameter so it needs no test framework of its own. This wrapper passes Vitest's, so
 * every adapter test here keeps calling it the short way:
 *
 *   import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
 *   describeStorageConformance("memory", async () => ({
 *     storage: memoryStorage(),
 *     cleanup: async () => {},
 *   }));
 *
 * See the kit's header for what `setup` must return and what is checked.
 */

import { afterEach, beforeEach, describe, it } from "vitest";
import {
  describeStorageConformance as describeWithFramework,
  type StorageConformanceFixture,
} from "../../src/testing/storage-conformance.ts";

export type { StorageConformanceFixture };

/** Registers the conformance tests for one adapter, with Vitest. */
export function describeStorageConformance(
  name: string,
  setup: () => Promise<StorageConformanceFixture>,
): void {
  describeWithFramework(name, setup, { describe, it, beforeEach, afterEach });
}
