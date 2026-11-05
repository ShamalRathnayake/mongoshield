/**
 * The providers `mongoshield login <provider>` knows, in the order help lists them.
 *
 * Each provider lives in its own module (gdrive.ts, onedrive.ts, dropbox.ts) that its
 * storage release owns, so this list never needs to change when one is improved.
 * Tests (and nothing else) add fakes with `registerLoginProvider`.
 */

import { MongoShieldError } from "../../errors.ts";
import { dropboxLoginProvider } from "./dropbox.ts";
import { gdriveLoginProvider } from "./gdrive.ts";
import { onedriveLoginProvider } from "./onedrive.ts";
import type { LoginProvider } from "./types.ts";

/** The built-in providers. */
const BUILT_IN: readonly LoginProvider[] = [
  gdriveLoginProvider,
  onedriveLoginProvider,
  dropboxLoginProvider,
];

/** Providers added at run time (tests). */
const extra: LoginProvider[] = [];

/** Every provider, built-in first. */
export function loginProviders(): readonly LoginProvider[] {
  return [...BUILT_IN, ...extra];
}

/** The provider called `id` (case-insensitive), or `undefined`. */
export function findLoginProvider(id: string): LoginProvider | undefined {
  const name = id.toLowerCase();
  return loginProviders().find((provider) => provider.id === name);
}

/**
 * Adds a provider (for tests: a fake that needs no network). Returns a function that
 * removes it again.
 *
 * @throws MS_INTERNAL when a provider with that id exists.
 */
export function registerLoginProvider(provider: LoginProvider): () => void {
  if (findLoginProvider(provider.id) !== undefined) {
    throw new MongoShieldError("MS_INTERNAL", `A login provider "${provider.id}" already exists.`);
  }
  extra.push(provider);
  return () => {
    const index = extra.indexOf(provider);
    if (index !== -1) extra.splice(index, 1);
  };
}
