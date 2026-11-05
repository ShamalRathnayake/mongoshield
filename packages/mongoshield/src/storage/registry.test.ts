/**
 * Tests for the storage-scheme registry: registering, refusing duplicates, replacing
 * on purpose, owners, undoing, and that `resolveStorage` dispatches through it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "./memory.ts";
import {
  isStorageSchemeRegistered,
  registeredStorageSchemes,
  registerStorageScheme,
  type StorageSchemeContext,
  type UnregisterStorageScheme,
} from "./registry.ts";
import { resolveStorage, SUPPORTED_STORAGE_SCHEMES } from "./resolve.ts";

/** Registrations made by a test, undone after it. */
const undo: UnregisterStorageScheme[] = [];

afterEach(() => {
  for (const unregister of undo.splice(0).reverse()) unregister();
});

function register(...args: Parameters<typeof registerStorageScheme>): void {
  undo.push(registerStorageScheme(...args));
}

function configError(run: () => unknown) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isMongoShieldError(caught, "MS_CONFIG_INVALID"), String(caught)).toBe(true);
  return isMongoShieldError(caught) ? caught : undefined;
}

describe("registerStorageScheme", () => {
  it("makes resolveStorage open the new scheme, passing the parsed URL and the env", async () => {
    const seen: StorageSchemeContext[] = [];
    register("pcloud", (context) => {
      seen.push(context);
      return memoryStorage({ name: "pcloud" });
    });
    const storage = await resolveStorage("PCloud://backups/prod?region=eu", {
      env: { PCLOUD_TOKEN: "t" },
    });
    expect(storage.location).toBe("memory://pcloud/");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scheme).toBe("pcloud");
    expect(seen[0]?.url).toBe("PCloud://backups/prod?region=eu");
    expect(seen[0]?.parsed.hostname).toBe("backups");
    expect(seen[0]?.parsed.pathname).toBe("/prod");
    expect(seen[0]?.parsed.searchParams.get("region")).toBe("eu");
    expect(seen[0]?.env.PCLOUD_TOKEN).toBe("t");
  });

  it("passes process.env when no env is given, and awaits async factories", async () => {
    let env: StorageSchemeContext["env"] | undefined;
    register("lazy", async (context) => {
      env = context.env;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return memoryStorage({ name: "lazy" });
    });
    expect((await resolveStorage("lazy://x")).location).toBe("memory://lazy/");
    expect(env).toBe(process.env);
  });

  it("lists registered schemes after the first-party ones, and forgets them when undone", () => {
    const unregister = registerStorageScheme("pcloud", () => memoryStorage());
    expect(registeredStorageSchemes()).toEqual([...SUPPORTED_STORAGE_SCHEMES, "pcloud"]);
    expect(isStorageSchemeRegistered("PCLOUD")).toBe(true);
    unregister();
    expect(isStorageSchemeRegistered("pcloud")).toBe(false);
    expect(registeredStorageSchemes()).toEqual([...SUPPORTED_STORAGE_SCHEMES]);
  });

  it("names every registered scheme in the hint for an unknown one", async () => {
    register("pcloud", () => memoryStorage());
    const error = await resolveStorage("webdav://host/x").catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("dropbox://, pcloud://");
    expect(isMongoShieldError(error) && error.hint).toContain("registerStorageScheme");
  });

  it("refuses a scheme another package registered, unless asked to replace it", async () => {
    register("pcloud", () => memoryStorage({ name: "first" }));
    const error = configError(() => registerStorageScheme("pcloud", () => memoryStorage()));
    expect(error?.message).toContain('"pcloud://" is already registered');
    expect(error?.hint).toContain("replace: true");

    register("pcloud", () => memoryStorage({ name: "second" }), { replace: true });
    expect((await resolveStorage("pcloud://x")).location).toBe("memory://second/");
  });

  it("refuses to take over a first-party scheme by accident", () => {
    for (const scheme of SUPPORTED_STORAGE_SCHEMES) {
      const error = configError(() => registerStorageScheme(scheme, () => memoryStorage()));
      expect(error?.hint).toContain("built into MongoShield");
    }
  });

  it("replaces a first-party scheme on purpose, and puts it back when undone", async () => {
    const unregister = registerStorageScheme("s3", () => memoryStorage({ name: "fake-s3" }), {
      replace: true,
    });
    expect((await resolveStorage("s3://bucket")).location).toBe("memory://fake-s3/");
    unregister();
    expect((await resolveStorage("s3://bucket")).location).toBe("s3://bucket/");
  });

  it("lets the same owner register again (a package evaluated twice), but not another owner", async () => {
    register("pcloud", () => memoryStorage({ name: "v1" }), { owner: "mongoshield-pcloud" });
    register("pcloud", () => memoryStorage({ name: "v2" }), { owner: "mongoshield-pcloud" });
    expect((await resolveStorage("pcloud://x")).location).toBe("memory://v2/");
    configError(() =>
      registerStorageScheme("pcloud", () => memoryStorage(), { owner: "someone-else" }),
    );
  });

  it("keeps a later replacement when an earlier registration is undone, and never revives it", async () => {
    const first = registerStorageScheme("pcloud", () => memoryStorage({ name: "first" }));
    const second = registerStorageScheme("pcloud", () => memoryStorage({ name: "second" }), {
      replace: true,
    });
    first();
    expect((await resolveStorage("pcloud://x")).location).toBe("memory://second/");
    second();
    expect(isStorageSchemeRegistered("pcloud")).toBe(false);
  });

  it("shares registrations between copies of the package through globalThis", () => {
    register("pcloud", () => memoryStorage());
    const shared = (globalThis as Record<symbol, unknown>)[
      Symbol.for("mongoshield.storage-schemes.v1")
    ];
    expect(shared).toBeInstanceOf(Map);
    expect((shared as Map<string, unknown>).has("pcloud")).toBe(true);
  });

  it.each([
    ["gdrive://mongoshield-backups", "Google Drive"],
    ["onedrive://backups", "OneDrive"],
    ["dropbox://backups", "Dropbox"],
  ])("reserves the drive scheme of %s until its release, failing clearly", async (url, service) => {
    const error = await resolveStorage(url).catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_NOT_IMPLEMENTED")).toBe(true);
    expect(String(error)).toContain(service);
    configError(() => registerStorageScheme(url.split(":")[0] ?? "", () => memoryStorage()));
  });

  it.each(["", "pcloud://", "1drive", "p cloud", "p_cloud"])(
    "rejects the scheme name %j",
    (scheme) => {
      configError(() => registerStorageScheme(scheme, () => memoryStorage()));
    },
  );

  it("rejects a factory that is not a function", () => {
    configError(() => registerStorageScheme("pcloud", "nope" as never));
  });
});
