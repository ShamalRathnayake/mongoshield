// Reading the analysis inputs out of a stored backup: metadata of every namespace,
// stored JavaScript, users and roles, include/exclude, and damaged files reported
// as unreadable rather than failing the analysis.

import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { replaceStoredFile, writeTestBackup } from "../../test/helpers/backup-fixtures.ts";
import { rewriteManifest } from "../../test/helpers/cli-backups.ts";
import type { Manifest } from "../format/manifest.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { sourceFromManifest } from "./read-pipeline.ts";
import { analyzeUpgradeCompatibility } from "./upgrade-compat.ts";
import { loadCompatibilityInput, MAX_DEFINITION_DOCUMENTS } from "./upgrade-inputs.ts";

/** A backup with a collection, a view, stored JavaScript, users and roles. */
async function fixture(storage: StorageAdapter): Promise<Manifest> {
  const written = await writeTestBackup(storage, {
    namespaces: [
      {
        ns: "app.items",
        documents: [{ _id: 1 }],
        options: { validator: { deletedAt: null } },
        indexes: [
          { v: 2, key: { _id: 1 }, name: "_id_" },
          { v: 1, key: { label: 1 }, name: "label" },
        ],
      },
      { ns: "app.recent", type: "view", options: { viewOn: "items", pipeline: [{ $limit: 1 }] } },
      {
        ns: "app.system.js",
        documents: [{ _id: "pad", value: new BSON.Code("function(s){ return String.trim(s) }") }],
      },
      {
        ns: "admin.system.users",
        documents: [{ _id: "app.old", user: "old", db: "app", credentials: { "MONGODB-CR": "x" } }],
      },
      {
        ns: "admin.system.roles",
        documents: [{ _id: "admin.cn=dba", role: "cn=dba,dc=x", db: "admin" }],
      },
    ],
  });
  // The fixture writer only knows collections: mark the authz entries as such.
  return rewriteManifest(storage, written, {
    namespaces: written.namespaces.map((entry) => {
      if (entry.ns === "admin.system.users") return { ...entry, type: "users" as const };
      if (entry.ns === "admin.system.roles") return { ...entry, type: "roles" as const };
      return entry;
    }),
  });
}

describe("loadCompatibilityInput", () => {
  it("reads metadata, stored JavaScript, users and roles", async () => {
    const storage = memoryStorage();
    const manifest = await fixture(storage);
    const input = await loadCompatibilityInput(
      sourceFromManifest(storage, manifest, undefined),
      manifest,
      "8.0",
    );

    expect(input.sourceVersion).toBe("7.0.0");
    expect(input.targetVersion).toBe("8.0");
    expect(input.collections.map((collection) => [collection.ns, collection.type])).toEqual([
      ["app.items", "collection"],
      ["app.recent", "view"],
      ["app.system.js", "collection"],
    ]);
    expect(input.storedJavaScript?.[0]?.documents[0]?._id).toBe("pad");
    expect(input.users?.[0]?.user).toBe("old");
    expect(input.roles?.[0]?.role).toBe("cn=dba,dc=x");
    expect(input.unreadable).toEqual([]);

    // Everything the rules need is there: one finding of each kind it holds.
    const rules = analyzeUpgradeCompatibility(input).findings.map((finding) => finding.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "index-version-legacy",
        "null-matches-undefined",
        "javascript-stored-removed-functions",
        "user-mongodb-cr",
        "role-ldap-mapping",
      ]),
    );
  });

  it("honours include and exclude for collections, never for users and roles", async () => {
    const storage = memoryStorage();
    const manifest = await fixture(storage);
    const input = await loadCompatibilityInput(
      sourceFromManifest(storage, manifest, undefined),
      manifest,
      "8.0",
      {
        include: ["app.*"],
        exclude: ["app.system.js"],
      },
    );
    expect(input.collections.map((collection) => collection.ns)).toEqual([
      "app.items",
      "app.recent",
    ]);
    expect(input.storedJavaScript).toEqual([]);
    expect(input.users).toHaveLength(1);
  });

  it("reports damaged metadata and users files as unreadable", async () => {
    const storage = memoryStorage();
    const manifest = await fixture(storage);
    const items = manifest.namespaces.find((entry) => entry.ns === "app.items");
    const users = manifest.namespaces.find((entry) => entry.type === "users");
    const flip = (bytes: Buffer) => {
      const copy = Buffer.from(bytes);
      copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 0xff;
      return copy;
    };
    await replaceStoredFile(storage, manifest, items?.metadata.key ?? "", flip);
    await replaceStoredFile(storage, manifest, users?.files[0]?.key ?? "", flip);

    const input = await loadCompatibilityInput(
      sourceFromManifest(storage, manifest, undefined),
      manifest,
      "8.0",
    );
    expect(input.unreadable?.map((entry) => entry.ns)).toEqual(["app.items", "admin.system.users"]);
    expect(input.collections.map((collection) => collection.ns)).not.toContain("app.items");
    expect(
      analyzeUpgradeCompatibility(input).findings.filter(
        (finding) => finding.rule === "metadata-unreadable",
      ),
    ).toHaveLength(2);
  });

  it("reads at most MAX_DEFINITION_DOCUMENTS documents of one entry", async () => {
    const storage = memoryStorage();
    const written = await writeTestBackup(storage, {
      namespaces: [
        {
          ns: "app.system.js",
          documents: Array.from({ length: MAX_DEFINITION_DOCUMENTS + 5 }, (_, index) => ({
            _id: `f${index}`,
            value: "1",
          })),
          documentsPerPart: 6000,
        },
      ],
    });
    const input = await loadCompatibilityInput(
      sourceFromManifest(storage, written, undefined),
      written,
      "8.0",
    );
    expect(input.storedJavaScript?.[0]?.documents).toHaveLength(MAX_DEFINITION_DOCUMENTS);
  });

  it("stops when aborted", async () => {
    const storage = memoryStorage();
    const manifest = await fixture(storage);
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCompatibilityInput(sourceFromManifest(storage, manifest, undefined), manifest, "8.0", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "MS_ABORTED" });
  });
});
