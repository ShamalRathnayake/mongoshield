import { Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { csvCell, csvCellText, csvText, valueAtPath } from "./export-text.ts";

describe("csvCell", () => {
  it("leaves plain text unquoted", () => {
    expect(csvCell("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvCell("")).toBe("");
  });

  it("quotes commas, quotes and line breaks, doubling inner quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it("quotes leading and trailing spaces so spreadsheets keep them", () => {
    expect(csvCell(" padded ")).toBe('" padded "');
  });
});

describe("csvText", () => {
  it("writes missing values and null as empty cells", () => {
    expect(csvText(undefined, true)).toBe("");
    expect(csvText(null, true)).toBe("");
  });

  it("writes numbers, wrappers, dates and ObjectIds plainly", () => {
    expect(csvText(42, true)).toBe("42");
    expect(csvText(new Int32(7), true)).toBe("7");
    expect(csvText(new Double(1.5), true)).toBe("1.5");
    expect(csvText(Long.fromString("9007199254740993"), true)).toBe("9007199254740993");
    expect(csvText(Decimal128.fromString("1.10"), true)).toBe("1.10");
    expect(csvText(true, true)).toBe("true");
    expect(csvText(new Date("2026-10-20T03:00:00Z"), true)).toBe("2026-10-20T03:00:00.000Z");
    const id = new ObjectId("6523f1c2a1b2c3d4e5f60718");
    expect(csvText(id, true)).toBe("6523f1c2a1b2c3d4e5f60718");
  });

  it("writes documents and arrays as Extended JSON in the chosen flavour", () => {
    expect(csvText({ a: 1 }, true)).toBe('{"a":1}');
    expect(csvText([new Int32(1)], false)).toBe('[{"$numberInt":"1"}]');
  });
});

describe("valueAtPath", () => {
  const document = {
    name: "Ada",
    address: { city: "Oslo" },
    items: [{ sku: "x" }, { sku: "y" }],
    tags: ["a"],
  };

  it("reads top-level and dotted paths", () => {
    expect(valueAtPath(document, "name")).toBe("Ada");
    expect(valueAtPath(document, "address.city")).toBe("Oslo");
  });

  it("indexes into arrays only with numeric segments", () => {
    expect(valueAtPath(document, "items.1.sku")).toBe("y");
    expect(valueAtPath(document, "items.sku")).toBeUndefined();
  });

  it("returns undefined for missing paths and paths through scalars", () => {
    expect(valueAtPath(document, "missing")).toBeUndefined();
    expect(valueAtPath(document, "name.first")).toBeUndefined();
  });
});

describe("CSV formula protection", () => {
  it("prefixes strings that a spreadsheet would run as formulas", () => {
    expect(csvCellText('=HYPERLINK("http://evil","x")', true)).toBe(
      '\'=HYPERLINK("http://evil","x")',
    );
    expect(csvCellText("+1 555 0100", true)).toBe("'+1 555 0100");
    expect(csvCellText("@SUM(A1)", true)).toBe("'@SUM(A1)");
  });

  it("leaves numbers and ordinary strings alone", () => {
    expect(csvCellText(-5, true)).toBe("-5");
    expect(csvCellText("hello", true)).toBe("hello");
  });
});
