/**
 * Loads a module as if MongoShield shipped no OAuth client for `provider`, for the
 * tests of the "bring your own app" error. The shipped client ids in
 * src/storage/oauth/apps.ts are real once the maintainer registers the apps, so those
 * tests cannot rely on them being empty.
 *
 *   const { gdriveClientCredentials } = await withoutShippedClient("gdrive", () =>
 *     import("../../src/storage/gdrive-auth.ts"),
 *   );
 *
 * The module (and everything it imports) is loaded fresh with `apps.ts` replaced, and the
 * replacement is undone before this returns, so other tests see the real apps.
 */

import { vi } from "vitest";
import type { OAuthProviderId } from "../../src/storage/oauth/apps.ts";

/** The absolute path of apps.ts, so the mock applies wherever it is imported from. */
const APPS_MODULE = new URL("../../src/storage/oauth/apps.ts", import.meta.url).pathname;

/** Imports `load()`'s module with `provider`'s shipped client id and secret empty. */
export async function withoutShippedClient<Module>(
  provider: OAuthProviderId,
  load: () => Promise<Module>,
): Promise<Module> {
  vi.resetModules();
  vi.doMock(APPS_MODULE, async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/storage/oauth/apps.ts")>();
    return {
      ...actual,
      OAUTH_APPS: {
        ...actual.OAUTH_APPS,
        [provider]: { ...actual.OAUTH_APPS[provider], clientId: "", clientSecret: "" },
      },
    };
  });
  try {
    return await load();
  } finally {
    vi.doUnmock(APPS_MODULE);
    vi.resetModules();
  }
}
