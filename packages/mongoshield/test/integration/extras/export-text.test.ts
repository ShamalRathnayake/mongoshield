// Text export (src/extras/export-text.ts): JSON Lines that read back (as mongoimport
// would, line by line through Extended JSON) to the exact backed-up documents, CSV
// quoting and escaping, filters, fields, and `mongoshield export --format jsonl|csv`.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  Binary,
  BSON,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  ObjectId,
  Timestamp,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDocuments } from "../../../src/extras/export-text.ts";
import { silentLogger } from "../../../src/logger.ts";
import { fileStorage } from "../../../src/storage/file.ts";
import { writeTestBackup } from "../../helpers/backup-fixtures.ts";
import { runTestCli } from "./cli-utils.ts";

/** Documents with awkward types and awkward text. */
const documents: Document[] = [
  {
    _id: new ObjectId("6523f1c2a1b2c3d4e5f60718"),
    name: 'Ada "the first" Lovelace',
    note: "line one\nline two, with a comma",
    count: new Int32(7),
    big: Long.fromString("9007199254740993"),
    ratio: new Double(2),
    price: Decimal128.fromString("19.99"),
    at: new Date("2026-10-20T03:00:00Z"),
    ts: new Timestamp({ t: 1_760_000_000, i: 3 }),
    blob: new Binary(Buffer.from("hello")),
    address: { city: "Oslo", zip: "0150" },
    tags: ["a", "b"],
    active: true,
  },
  { _id: 2, name: "  spaced  ", address: { city: "Bergen" }, active: false },
  { _id: 3, name: "Grace", active: true, nothing: null },
];

let workDir: string;
let storageDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-export-text-"));
  storageDir = join(workDir, "backups");
  await writeTestBackup(fileStorage({ path: storageDir }), {
    namespaces: [{ ns: "app.users", documents }],
  });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function context() {
  return { storage: fileStorage({ path: storageDir }), logger: silentLogger };
}

describe("exportDocuments as JSON Lines", () => {
  it("round-trips canonical Extended JSON to the exact backed-up BSON", async () => {
    const output = join(workDir, "users-canonical.jsonl");
    const result = await exportDocuments(context(), {
      backup: "latest",
      namespace: "app.users",
      format: "jsonl",
      ejson: "canonical",
      output,
    });
    expect(result.documents).toBe(3);

    const lines = (await readFile(output, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const imported = lines.map((line) => BSON.EJSON.parse(line, { relaxed: false }) as Document);
    for (const [index, document] of imported.entries()) {
      const original = Buffer.from(BSON.serialize(documents[index] ?? {}));
      expect(Buffer.from(BSON.serialize(document)).equals(original)).toBe(true);
    }
  });

  it("writes relaxed JSON by default, filtered and projected", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    await exportDocuments(context(), {
      backup: "latest",
      namespace: "app.users",
      format: "jsonl",
      filter: { active: true },
      fields: ["name", "address.city"],
      output: sink,
    });
    const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        _id: { $oid: "6523f1c2a1b2c3d4e5f60718" },
        name: 'Ada "the first" Lovelace',
        address: { city: "Oslo" },
      },
      { _id: 3, name: "Grace" },
    ]);
  });

  it("never overwrites an existing file", async () => {
    const output = join(workDir, "exists.jsonl");
    await writeFile(output, "keep me");
    await expect(
      exportDocuments(context(), {
        backup: "latest",
        namespace: "app.users",
        format: "jsonl",
        output,
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect(await readFile(output, "utf8")).toBe("keep me");
  });
});

describe("exportDocuments as CSV", () => {
  it("writes a header and quotes and escapes cells per RFC 4180", async () => {
    const output = join(workDir, "users.csv");
    await exportDocuments(context(), {
      backup: "latest",
      namespace: "app.users",
      format: "csv",
      fields: [
        "_id",
        "name",
        "note",
        "count",
        "big",
        "price",
        "at",
        "address.city",
        "tags",
        "nothing",
      ],
      output,
    });
    const text = await readFile(output, "utf8");
    expect(text.split("\n")[0]).toBe("_id,name,note,count,big,price,at,address.city,tags,nothing");
    expect(text).toContain(
      [
        "6523f1c2a1b2c3d4e5f60718",
        '"Ada ""the first"" Lovelace"',
        '"line one\nline two, with a comma"',
        "7",
        "9007199254740993",
        "19.99",
        "2026-10-20T03:00:00.000Z",
        "Oslo",
        '"[""a"",""b""]"',
        "",
      ].join(","),
    );
    expect(text).toContain('2,"  spaced  ",,,,,,Bergen,,\n');
    expect(text.endsWith("3,Grace,,,,,,,,\n")).toBe(true);
  });

  it("requires fields", async () => {
    await expect(
      exportDocuments(context(), {
        backup: "latest",
        namespace: "app.users",
        format: "csv",
        output: join(workDir, "nofields.csv"),
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });
});

describe("exportDocuments options", () => {
  it.each([
    ["an empty output path", { format: "jsonl", output: "" }, /output path is empty/],
    ["an unknown format", { format: "xml", output: "x.xml" }, /Unknown text export format "xml"/],
    ["an unknown Extended JSON mode", { format: "jsonl", ejson: "loose" }, /Extended JSON mode/],
    ["an empty field list", { format: "csv", fields: [] }, /list of fields is empty/],
    ["a field with an empty segment", { format: "csv", fields: ["a..b"] }, /is not a field path/],
    ["a field starting with $", { format: "csv", fields: ["$where"] }, /is not a field path/],
    ["a field listed twice", { format: "csv", fields: ["name", "name"] }, /listed twice/],
    ["a malformed namespace", { format: "jsonl", namespace: "users" }, /not a valid namespace/],
  ])("refuses %s", async (_name, overrides, message) => {
    const options = {
      backup: "latest",
      namespace: "app.users",
      output: join(workDir, `refused-${Math.random()}.txt`),
      ...overrides,
    } as Parameters<typeof exportDocuments>[1];
    await expect(exportDocuments(context(), options)).rejects.toThrow(message);
  });

  it("writes CSV to a stream in canonical mode and stops at a missing namespace", async () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    await exportDocuments(context(), {
      backup: "latest",
      namespace: "app.users",
      format: "csv",
      ejson: "canonical",
      fields: ["_id", "count"],
      output,
    });
    expect(chunks.join("").split("\n")[0]).toBe("_id,count");
    expect(chunks.join("")).toContain("6523f1c2a1b2c3d4e5f60718,7");
    await expect(
      exportDocuments(context(), {
        backup: "latest",
        namespace: "app.missing",
        format: "jsonl",
        output: join(workDir, "missing.jsonl"),
      }),
    ).rejects.toThrow(/app\.missing/);
  });
});

describe("mongoshield export --format jsonl|csv", () => {
  it("writes CSV to stdout", async () => {
    const run = await runTestCli(
      [
        "export",
        "--from",
        storageDir,
        "--format",
        "csv",
        "--namespace",
        "app.users",
        "--fields",
        "_id, name",
        "--filter",
        '{"_id":{"$in":[2,3]}}',
        "--output",
        "-",
      ],
      workDir,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('_id,name\n2,"  spaced  "\n3,Grace\n');
  });

  it("writes JSON Lines to a file", async () => {
    const run = await runTestCli(
      [
        "export",
        "--from",
        storageDir,
        "--format",
        "jsonl",
        "--namespace",
        "app.users",
        "--output",
        "cli.jsonl",
      ],
      workDir,
    );
    expect(run.code).toBe(0);
    expect((await readFile(join(workDir, "cli.jsonl"), "utf8")).trimEnd().split("\n")).toHaveLength(
      3,
    );
  });

  it("rejects text-only flags with mongodump formats and vice versa", async () => {
    const mixed = await runTestCli(
      ["export", "--from", storageDir, "--namespace", "app.users", "--output", "dump"],
      workDir,
    );
    expect(mixed.code).toBe(2);
    const gzip = await runTestCli(
      [
        "export",
        "--from",
        storageDir,
        "--format",
        "csv",
        "--gzip",
        "--namespace",
        "app.users",
        "--output",
        "x.csv",
      ],
      workDir,
    );
    expect(gzip.code).toBe(2);
  });
});
