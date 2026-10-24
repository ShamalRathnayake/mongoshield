// Scanning mongodump directories and reading their metadata: the layouts real dumps
// have (one directory per database, a single database's directory, gzipped files,
// legacy .bin files) and the ones they should not have (stray files, duplicates).

import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { readDumpTextFile, scanDumpDirectory } from "./dump-directory.ts";
import { parseDumpMetadata, recordedCollectionName } from "./dump-metadata.ts";
import { fixturePath, rejection, useTempDirectories } from "./test-fixtures.ts";

const tempDirectory = useTempDirectories();

/** A dump directory with one database `app` holding `files`. */
async function dumpWith(
  files: Record<string, string | Buffer>,
  top: Record<string, string | Buffer> = {},
) {
  const root = await tempDirectory();
  await mkdir(join(root, "app"));
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(root, "app", name), contents);
  for (const [name, contents] of Object.entries(top)) await writeFile(join(root, name), contents);
  return root;
}

describe("scanDumpDirectory", () => {
  it("lists the collections of each database directory, sorted, with their files", async () => {
    const scan = await scanDumpDirectory(fixturePath("dump"));
    expect(scan.collections.map((files) => `${files.db}/${files.stem}`)).toEqual([
      "app/capped",
      "app/empty",
      "app/system.buckets.ts",
      "app/ts",
      "app/users",
      "app/v1",
      "app/we%2Fird+name%2Bx~%C3%A9",
    ]);
    expect(scan.collections.find((files) => files.stem === "v1")?.data).toBeUndefined();
    expect(scan).toMatchObject({
      serverVersion: "7.0.32",
      toolVersion: "100.16.0",
      ignored: [],
      oplog: undefined,
    });
    expect(scan.newestFileTime).toBeInstanceOf(Date);
  });

  it("finds the oplog of mongodump --oplog, plain or gzipped", async () => {
    for (const name of ["oplog.bson", "oplog.bson.gz"]) {
      const root = await dumpWith({ "users.bson": Buffer.alloc(0) }, { [name]: Buffer.alloc(0) });
      const scan = await scanDumpDirectory(root);
      expect(scan.oplog).toEqual({ path: join(root, name), gzip: name.endsWith(".gz") });
      expect(scan.collections.map((files) => files.db)).toEqual(["app"]);
    }
  });

  it("reports stray files and directories, and reads legacy .bin files", async () => {
    const root = await dumpWith(
      { "notes.txt": "x", "old.bin": Buffer.alloc(0) },
      { "README.md": "x" },
    );
    await mkdir(join(root, "app", "nested"));
    const scan = await scanDumpDirectory(root);
    expect(scan.ignored.map((file) => [file.path.slice(root.length + 1), file.reason])).toEqual([
      ["README.md", "not part of a mongodump directory"],
      [join("app", "nested"), "unexpected subdirectory"],
      [join("app", "notes.txt"), "not a .bson or .metadata.json file"],
    ]);
    expect(
      scan.collections.map((files) => [files.stem, files.data?.path.endsWith("old.bin")]),
    ).toEqual([["old", true]]);
  });

  it("refuses two files for the same collection", async () => {
    const root = await dumpWith({
      "users.bson": Buffer.alloc(0),
      "users.bson.gz": gzipSync(Buffer.alloc(0)),
    });
    expect(isMongoShieldError(await rejection(scanDumpDirectory(root)), "MS_CONFIG_INVALID")).toBe(
      true,
    );
  });

  it("reads the prelude of a database directory, and ignores a damaged prelude", async () => {
    const root = await tempDirectory();
    await cp(fixturePath("dump/app"), join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "prelude.json"), "not json");
    expect((await scanDumpDirectory(root)).serverVersion).toBeUndefined();
    await writeFile(join(root, "app", "prelude.json"), "5");
    expect((await scanDumpDirectory(root)).serverVersion).toBeUndefined();
    await writeFile(
      join(root, "app", "prelude.json"),
      JSON.stringify({ ServerVersion: 7, ToolVersion: "100.9.0" }),
    );
    expect(await scanDumpDirectory(root)).toMatchObject({
      serverVersion: undefined,
      toolVersion: "100.9.0",
    });
  });

  it("refuses a path that is not a directory, or a directory without a dump", async () => {
    expect(
      isMongoShieldError(
        await rejection(scanDumpDirectory(fixturePath("app.archive"))),
        "MS_CONFIG_INVALID",
      ),
    ).toBe(true);
    const root = await tempDirectory();
    await writeFile(join(root, "prelude.json"), "{}");
    expect(isMongoShieldError(await rejection(scanDumpDirectory(root)), "MS_CONFIG_INVALID")).toBe(
      true,
    );
  });
});

describe("readDumpTextFile", () => {
  it("reads plain and gzipped files, and refuses files above the size limit", async () => {
    const root = await tempDirectory();
    await writeFile(join(root, "a.json"), "{}");
    await writeFile(join(root, "a.json.gz"), gzipSync("{}"));
    expect(await readDumpTextFile({ path: join(root, "a.json"), gzip: false })).toBe("{}");
    expect(await readDumpTextFile({ path: join(root, "a.json.gz"), gzip: true })).toBe("{}");
    const error = await rejection(readDumpTextFile({ path: join(root, "a.json"), gzip: false }, 1));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });
});

describe("parseDumpMetadata", () => {
  it("treats empty metadata as a plain collection named by the file", () => {
    expect(parseDumpMetadata("  ", "users", "x")).toEqual({
      collectionName: "users",
      type: "collection",
      options: {},
      indexes: [],
    });
  });

  it("infers the type of old metadata without one, like mongorestore", () => {
    const typeOf = (options: unknown) =>
      parseDumpMetadata(JSON.stringify({ options, indexes: [] }), "c", "x").type;
    expect(typeOf({ viewOn: "users", pipeline: [] })).toBe("view");
    expect(typeOf({ timeseries: { timeField: "t" } })).toBe("timeseries");
    expect(typeOf({ capped: true, size: 1024 })).toBe("collection");
    expect(parseDumpMetadata(JSON.stringify({ indexes: [] }), "c", "x").type).toBe("collection");
  });

  it("prefers the file's name over the metadata's collectionName", () => {
    const metadata = parseDumpMetadata(
      JSON.stringify({ collectionName: "other", type: "collection" }),
      "users",
      "x",
    );
    expect(metadata.collectionName).toBe("users");
    expect(recordedCollectionName(JSON.stringify({ collectionName: "real" }), "x")).toBe("real");
    expect(recordedCollectionName(JSON.stringify({ collectionName: "" }), "x")).toBeUndefined();
  });

  it("refuses metadata that is not a JSON object", () => {
    for (const text of ["not json", "[1]", "5"]) {
      let error: unknown;
      try {
        parseDumpMetadata(text, "c", "x");
      } catch (caught) {
        error = caught;
      }
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    }
  });
});
