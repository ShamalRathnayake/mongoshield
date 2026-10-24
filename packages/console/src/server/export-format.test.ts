/**
 * Unit tests for the export file formats: JSON and JSON Lines framing, canonical
 * Extended JSON, CSV flattening, RFC 4180 quoting, the formula-injection guard, the byte
 * cap (exact for every format) and the query parameter parsers.
 */

import {
  Binary,
  type BSON,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  ObjectId,
  Timestamp,
  UUID,
} from "mongodb";
import { describe, expect, it } from "vitest";
import {
  collectExport,
  createExportWriter,
  csvEscape,
  csvValue,
  exportFilename,
  flattenDocument,
  parseEjsonMode,
  parseExportFormat,
} from "./export-format.ts";

/** Plenty of room: the byte cap does not matter for the test. */
const ROOMY = 1024 * 1024;

/** The text of an export of `documents` in `format`. */
function exportOf(
  format: "json" | "jsonl" | "csv",
  documents: BSON.Document[],
  ejson: "relaxed" | "canonical" = "relaxed",
): string {
  const writer = createExportWriter(format, ejson, ROOMY);
  for (const document of documents) expect(writer.add(document)).toBe(true);
  return writer.finish();
}

/** An async source of documents, like a cursor or a backup stream, that records closing. */
function sourceOf(documents: BSON.Document[]) {
  const state = { read: 0, closed: false };
  async function* generate() {
    try {
      for (const document of documents) {
        state.read += 1;
        yield document;
      }
    } finally {
      state.closed = true;
    }
  }
  return { source: generate(), state };
}

describe("json and jsonl", () => {
  it("write one document per line, framed as an array or as lines", () => {
    const documents = [{ _id: 1, a: "x" }, { _id: 2 }];
    expect(exportOf("json", documents)).toBe('[\n{"_id":1,"a":"x"},\n{"_id":2}\n]');
    expect(exportOf("jsonl", documents)).toBe('{"_id":1,"a":"x"}\n{"_id":2}\n');
    expect(JSON.parse(exportOf("json", documents))).toEqual(documents);
  });

  it("write an empty export as an empty array or nothing", () => {
    expect(exportOf("json", [])).toBe("[]");
    expect(exportOf("jsonl", [])).toBe("");
  });

  it("write canonical Extended JSON when asked", () => {
    const document = { _id: new Int32(1), price: new Double(2), big: Long.fromString("7") };
    expect(exportOf("jsonl", [document], "canonical")).toBe(
      '{"_id":{"$numberInt":"1"},"price":{"$numberDouble":"2.0"},"big":{"$numberLong":"7"}}\n',
    );
    expect(exportOf("jsonl", [document])).toBe('{"_id":1,"price":2,"big":7}\n');
  });

  it("stop exactly at the byte cap, framing included", () => {
    // Each line is 9 bytes ({"_id":1}); json: 4 bytes of framing first, 2 per later line.
    const exact = 4 + 9 + 2 + 9;
    const json = createExportWriter("json", "relaxed", exact);
    expect(json.add({ _id: 1 })).toBe(true);
    expect(json.add({ _id: 2 })).toBe(true);
    expect(json.add({ _id: 3 })).toBe(false);
    expect(Buffer.byteLength(json.finish())).toBe(exact);
    expect(json.documents).toBe(2);

    const jsonl = createExportWriter("jsonl", "relaxed", 10);
    expect(jsonl.add({ _id: 1 })).toBe(true);
    expect(jsonl.add({ _id: 2 })).toBe(false);
    expect(jsonl.finish()).toBe('{"_id":1}\n');
  });

  it("count UTF-8 bytes, not characters", () => {
    // "é" is 2 bytes: {"a":"é"} is 10 bytes, plus 1 for the newline.
    expect(createExportWriter("jsonl", "relaxed", 10).add({ a: "é" })).toBe(false);
    expect(createExportWriter("jsonl", "relaxed", 11).add({ a: "é" })).toBe(true);
  });
});

describe("csv", () => {
  it("has a header of field paths in order of first appearance, and empty missing cells", () => {
    const text = exportOf("csv", [
      { _id: 1, name: "Ada" },
      { _id: 2, email: "b@example.com", name: "Bob" },
    ]);
    expect(text).toBe("_id,name,email\r\n1,Ada,\r\n2,Bob,b@example.com\r\n");
  });

  it("flattens nested objects with dots, keeps arrays as JSON text and empty objects as {}", () => {
    const text = exportOf("csv", [
      { _id: 1, address: { city: "Oslo", geo: { lat: 59.9 } }, tags: ["a", "b"], meta: {} },
    ]);
    expect(text).toBe(
      '_id,address.city,address.geo.lat,tags,meta\r\n1,Oslo,59.9,"[""a"",""b""]",{}\r\n',
    );
  });

  it("writes BSON values as one readable cell each", () => {
    const id = new ObjectId("64b7f0c2a1b2c3d4e5f60718");
    const cells = flattenDocument(
      {
        _id: id,
        at: new Date("2026-10-24T12:00:00.000Z"),
        price: Decimal128.fromString("9.99"),
        count: Long.fromString("12345678901234"),
        small: new Int32(3),
        ratio: new Double(0.5),
        bytes: new Binary(Buffer.from("hi")),
        buffer: Buffer.from("yo"),
        uuid: new UUID("0e3d1a4c-8f0b-4f6a-9a51-6b2b1c7d8e9f"),
        stamp: new Timestamp({ t: 1, i: 2 }),
        top: new MaxKey(),
        none: null,
        yes: true,
        huge: 12n,
      },
      "relaxed",
    );
    expect(Object.fromEntries(cells)).toEqual({
      _id: "64b7f0c2a1b2c3d4e5f60718",
      at: "2026-10-24T12:00:00.000Z",
      price: "9.99",
      count: "12345678901234",
      small: "3",
      ratio: "0.5",
      bytes: Buffer.from("hi").toString("base64"),
      buffer: Buffer.from("yo").toString("base64"),
      uuid: Buffer.from("0e3d1a4c8f0b4f6a9a516b2b1c7d8e9f", "hex").toString("base64"),
      // Uncommon types: their Extended JSON text (quoted because it has commas and quotes).
      stamp: '"{""$timestamp"":{""t"":1,""i"":2}}"',
      top: '"{""$maxKey"":1}"',
      none: "",
      yes: "true",
      huge: "12",
    });
  });

  it("writes an invalid date as its Extended JSON text", () => {
    expect(csvValue(new Date(Number.NaN), "relaxed").text).toContain("$date");
  });

  it("quotes cells with commas, quotes, CR or LF, doubling the quotes (RFC 4180)", () => {
    expect(csvEscape("plain", true)).toBe("plain");
    expect(csvEscape("a,b", true)).toBe('"a,b"');
    expect(csvEscape('say "hi"', true)).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak", true)).toBe('"line\nbreak"');
    expect(csvEscape("cr\rhere", true)).toBe('"cr\rhere"');
  });

  it("guards text cells a spreadsheet would run as a formula, but not numbers", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvEscape(`${start}SUM(A1)`, true).replace(/^"/, "")).toMatch(/^'/);
    }
    expect(csvEscape("=1+2", false)).toBe("=1+2");
    const text = exportOf("csv", [
      { _id: 1, link: '=HYPERLINK("http://evil")', delta: -5, at: "@home", "=field": 1 },
    ]);
    expect(text).toBe(
      `_id,link,delta,at,'=field\r\n1,"'=HYPERLINK(""http://evil"")",-5,'@home,1\r\n`,
    );
  });

  it("writes nothing for no documents, and an empty row for an empty document", () => {
    expect(exportOf("csv", [])).toBe("");
    expect(exportOf("csv", [{ _id: 1 }, {}])).toBe("_id\r\n1\r\n\r\n");
  });

  it("stops exactly at the byte cap, counting the empty cells new columns add", () => {
    // "a\r\n1\r\n" is 6 bytes; adding {b: 2} makes "a,b\r\n1,\r\n,2\r\n": 13 bytes.
    const tight = createExportWriter("csv", "relaxed", 12);
    expect(tight.add({ a: 1 })).toBe(true);
    expect(tight.add({ b: 2 })).toBe(false);
    expect(tight.finish()).toBe("a\r\n1\r\n");
    const exact = createExportWriter("csv", "relaxed", 13);
    expect(exact.add({ a: 1 })).toBe(true);
    expect(exact.add({ b: 2 })).toBe(true);
    expect(exact.finish()).toBe("a,b\r\n1,\r\n,2\r\n");
    expect(exact.documents).toBe(2);
  });
});

describe("collecting an export", () => {
  it("reads everything when it fits, and says it is complete", async () => {
    const { source, state } = sourceOf([{ _id: 1 }, { _id: 2 }]);
    const writer = createExportWriter("jsonl", "relaxed", ROOMY);
    expect(await collectExport(source, writer, 10)).toEqual({ truncated: false });
    expect(writer.documents).toBe(2);
    expect(state.closed).toBe(true);
  });

  it("stops at the limit, closes the source and says it is truncated", async () => {
    const { source, state } = sourceOf([{ _id: 1 }, { _id: 2 }, { _id: 3 }, { _id: 4 }]);
    const writer = createExportWriter("json", "relaxed", ROOMY);
    expect(await collectExport(source, writer, 2)).toEqual({ truncated: true });
    expect(writer.documents).toBe(2);
    // The third document proved there were more; the fourth was never read.
    expect(state.read).toBe(3);
    expect(state.closed).toBe(true);
  });

  it("is not truncated when the source has exactly the limit", async () => {
    const { source } = sourceOf([{ _id: 1 }, { _id: 2 }]);
    const writer = createExportWriter("csv", "relaxed", ROOMY);
    expect(await collectExport(source, writer, 2)).toEqual({ truncated: false });
  });

  it("stops at the byte cap and says it is truncated", async () => {
    const { source } = sourceOf([{ _id: 1 }, { _id: 2 }]);
    const writer = createExportWriter("jsonl", "relaxed", 12);
    expect(await collectExport(source, writer, 10)).toEqual({ truncated: true });
    expect(writer.documents).toBe(1);
  });
});

describe("parameters and file names", () => {
  it("parse the Extended JSON flavour", () => {
    expect(parseEjsonMode(undefined)).toBe("relaxed");
    expect(parseEjsonMode("")).toBe("relaxed");
    expect(parseEjsonMode("relaxed")).toBe("relaxed");
    expect(parseEjsonMode("canonical")).toBe("canonical");
    expect(() => parseEjsonMode("strict")).toThrow(/relaxed/);
  });

  it("parse the format", () => {
    expect(parseExportFormat(undefined)).toBe("json");
    expect(parseExportFormat("")).toBe("json");
    expect(parseExportFormat("jsonl")).toBe("jsonl");
    expect(parseExportFormat("csv")).toBe("csv");
    expect(() => parseExportFormat("xlsx")).toThrow(/csv/);
  });

  it("make safe file names", () => {
    expect(exportFilename(["shop.orders"], "csv")).toBe("shop.orders.csv");
    expect(exportFilename(["shop.orders", "2026-10-24T03-00-00Z_abcdef"], "jsonl")).toBe(
      "shop.orders.2026-10-24T03-00-00Z_abcdef.jsonl",
    );
    expect(exportFilename(["app.../etc/passwd"], "json")).toBe("app..._etc_passwd.json");
    expect(exportFilename([".hidden"], "json")).toBe("_hidden.json");
    expect(exportFilename(['a\r\nb"c'], "json")).toBe("a__b_c.json");
    expect(exportFilename([""], "csv")).toBe("export.csv");
    expect(exportFilename(["x".repeat(300)], "csv")).toHaveLength(204);
  });
});
