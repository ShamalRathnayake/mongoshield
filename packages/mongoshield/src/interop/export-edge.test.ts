// exportBackup on backups and options that the round-trip tests do not produce:
// refused options, manifests that disagree with their files or name impossible
// databases, unknown server versions, and users and roles in both mongodump forms.

import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { BSON, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { manifestKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import { serializeManifest } from "../format/manifest-io.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { ArchiveEvent } from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { exportBackup } from "./export.ts";
import { importMongodump } from "./import.ts";
import { fixturePath, rejection, splitBson, useTempDirectories } from "./test-fixtures.ts";

const tempDirectory = useTempDirectories();

function bson(...documents: Record<string, unknown>[]): Buffer {
  return Buffer.concat(documents.map((document) => Buffer.from(BSON.serialize(document))));
}

const user = (db: string, name: string) => ({
  _id: `${db}.${name}`,
  userId: new ObjectId(),
  user: name,
  db,
  credentials: {},
  roles: [],
});

/** A backup imported from the fixture dump, plus users of `app` and `admin`. */
async function backupWithUsers(): Promise<{ storage: MemoryStorage; manifest: Manifest }> {
  const root = await tempDirectory();
  await cp(fixturePath("dump"), root, { recursive: true });
  await mkdir(join(root, "admin"));
  await writeFile(
    join(root, "admin", "system.users.bson"),
    bson(user("app", "amy"), user("admin", "root")),
  );
  await writeFile(
    join(root, "admin", "system.roles.bson"),
    bson({ _id: "app.r", role: "r", db: "app", privileges: [], roles: [] }),
  );
  const storage = memoryStorage();
  const { manifest } = await importMongodump({ directory: root }, storage);
  return { storage, manifest };
}

/** Replaces the stored manifest of a backup (to simulate one that was tampered with). */
async function replaceManifest(storage: MemoryStorage, manifest: Manifest): Promise<void> {
  await storage.put(manifestKey(manifest.id), Buffer.from(serializeManifest(manifest), "utf8"));
}

describe("exportBackup options", () => {
  it("refuses an unknown format, a bad parallelism, a stream for a directory and an empty path", async () => {
    const { storage, manifest } = await backupWithUsers();
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    for (const options of [
      { format: "tar" as "archive", output: "x" },
      { format: "directory" as const, output: "x", parallelism: 0 },
      { format: "directory" as const, output: sink },
      { format: "archive" as const, output: "" },
    ]) {
      expect(
        isMongoShieldError(
          await rejection(exportBackup(storage, manifest.id, options)),
          "MS_CONFIG_INVALID",
        ),
      ).toBe(true);
    }
  });

  it("refuses an output path it cannot use as a directory", async () => {
    const { storage, manifest } = await backupWithUsers();
    const file = join(await tempDirectory(), "file");
    await writeFile(file, "x");
    const error = await rejection(
      exportBackup(storage, manifest.id, { format: "directory", output: file }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});

describe("exportBackup of users and roles", () => {
  it("writes the full-dump form and a per-database form for every database but admin", async () => {
    const { storage, manifest } = await backupWithUsers();
    const output = join(await tempDirectory(), "dump");
    const summary = await exportBackup(storage, manifest.id, {
      format: "directory",
      output,
      gzip: true,
    });
    expect(summary.usersAndRoles).toEqual({ users: 2, roles: 1 });
    expect((await readdir(join(output, "admin"))).sort()).toEqual([
      "system.roles.bson.gz",
      "system.users.bson.gz",
      "system.version.bson.gz",
    ]);
    expect((await readdir(join(output, "app"))).filter((name) => name.startsWith("$"))).toEqual([
      "$admin.system.roles.bson.gz",
      "$admin.system.users.bson.gz",
      "$admin.system.version.bson.gz",
    ]);
  });

  it("puts users and roles first in an archive, with the auth schema version", async () => {
    const { storage, manifest } = await backupWithUsers();
    const output = join(await tempDirectory(), "users.archive");
    await exportBackup(storage, manifest.id, { format: "archive", output });
    const events: ArchiveEvent[] = [];
    for await (const event of createReadStream(output).pipe(createArchiveReader())) {
      events.push(event as ArchiveEvent);
    }
    const prelude = events[0];
    if (prelude?.kind !== "prelude") throw new Error("no prelude");
    expect(
      prelude.collections.slice(0, 6).map((entry) => `${entry.db}.${entry.collection}`),
    ).toEqual([
      "admin.system.users",
      "admin.system.roles",
      "admin.system.version",
      "app.$admin.system.users",
      "app.$admin.system.roles",
      "app.$admin.system.version",
    ]);
    const version = events.find(
      (event) => event.kind === "document" && event.collection === "system.version",
    );
    if (version?.kind !== "document") throw new Error("no auth schema version");
    expect(BSON.deserialize(version.document)).toEqual({
      _id: "authSchema",
      currentVersion: 5,
    });
  });
});

describe("exportBackup of inconsistent backups", () => {
  it("refuses a manifest whose document count does not match its files", async () => {
    const { storage, manifest } = await backupWithUsers();
    await replaceManifest(storage, {
      ...manifest,
      namespaces: manifest.namespaces.map((entry) =>
        entry.ns === "app.users" ? { ...entry, documents: entry.documents + 1 } : entry,
      ),
    });
    for (const format of ["directory", "archive"] as const) {
      const output = join(await tempDirectory(), "out");
      expect(
        isMongoShieldError(
          await rejection(exportBackup(storage, manifest.id, { format, output })),
          "MS_INTEGRITY_FAILED",
        ),
      ).toBe(true);
    }
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    expect(
      isMongoShieldError(
        await rejection(exportBackup(storage, manifest.id, { format: "archive", output: sink })),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
  });

  it("refuses to write outside the output directory for a database name MongoDB forbids", async () => {
    const { storage, manifest } = await backupWithUsers();
    await replaceManifest(storage, {
      ...manifest,
      namespaces: manifest.namespaces.map((entry) =>
        entry.ns === "app.users" ? { ...entry, db: "..", ns: "...users" } : entry,
      ),
    });
    const error = await rejection(
      exportBackup(storage, manifest.id, {
        format: "directory",
        output: join(await tempDirectory(), "out"),
      }),
    );
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("refuses two namespaces that map to the same file, removing only its own files", async () => {
    const { storage, manifest } = await backupWithUsers();
    const users = manifest.namespaces.find((entry) => entry.ns === "app.users");
    if (users === undefined) throw new Error("no users");
    await replaceManifest(storage, { ...manifest, namespaces: [...manifest.namespaces, users] });
    const output = join(await tempDirectory(), "out");
    const error = await rejection(
      exportBackup(storage, manifest.id, { format: "directory", output, parallelism: 1 }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(
      (await readdir(output, { recursive: true })).filter((name) => name.endsWith(".bson")),
    ).toEqual([]);
  });

  it("writes no prelude.json, and 0.0.0 in an archive, when the server version is unknown", async () => {
    const { storage, manifest } = await backupWithUsers();
    await replaceManifest(storage, {
      ...manifest,
      source: { ...manifest.source, serverVersion: "unknown" },
    });
    const directory = join(await tempDirectory(), "out");
    await exportBackup(storage, manifest.id, { format: "directory", output: directory });
    expect(await readdir(directory)).not.toContain("prelude.json");
    const archive = join(await tempDirectory(), "out.archive");
    await exportBackup(storage, manifest.id, { format: "archive", output: archive });
    const header = splitBson((await readFile(archive)).subarray(4))[0];
    expect(BSON.deserialize(header ?? Buffer.alloc(0)).server_version).toBe("0.0.0");
  });
});
