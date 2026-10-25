// Random documents whose field order JavaScript objects cannot hold: field names that
// look like integers ("0", "7", "42") at random positions and depths, inside arrays of
// documents and inside an embedded-document `_id`. Documents are built as Maps, which
// js-bson serializes in insertion order, so their BSON bytes are exactly as generated.
// Shared by the unit tests of src/format/field-order.ts and the integration tests of
// every write path (test/integration/field-order.test.ts).

import fc from "fast-check";
import { BSON, Double, Int32, Long } from "mongodb";

/** A stored document as generated: a Map in stored field order. */
export type OrderedDocument = Map<string, unknown>;

/**
 * Field names: plain ones, integer-like ones (which JavaScript lists first), and
 * near misses that are NOT integer-like ("01", "-1", "4294967295", the first number
 * past the largest array index), which must stay where they are too. No `$` or `.`:
 * the server refuses them in some positions, and they are not what this is about.
 */
export const fieldName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("a", "b", "name", "z", "_k", "01", "-1", "1x", "4294967295"),
  fc.nat(40).map(String),
  fc.constantFrom("4294967294", "1000000"),
);

const scalar: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map((n) => new Int32(n)),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => new Double(n)),
  fc.integer().map((n) => Long.fromNumber(n)),
  fc.string({ maxLength: 6 }),
  fc.boolean(),
  fc.constant(null),
  fc.date({ min: new Date(0), max: new Date(4_000_000_000_000), noInvalidDate: true }),
);

/** Distinct field names with values, in random order. */
function fields(value: fc.Arbitrary<unknown>, maxLength: number): fc.Arbitrary<OrderedDocument> {
  return fc
    .uniqueArray(fc.tuple(fieldName, value), { maxLength, selector: ([name]) => name })
    .map((entries) => new Map(entries));
}

/** Values nested a few levels deep: scalars, arrays (of documents, too) and documents. */
export const storedValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { arbitrary: scalar, weight: 3 },
    { arbitrary: fc.array(tie("value"), { maxLength: 3 }), weight: 1 },
    { arbitrary: fields(tie("value"), 4), weight: 2 },
  ),
})).value;

/** A document value: an embedded document (a Map) with integer-like names likely. */
export const embeddedDocument: fc.Arbitrary<OrderedDocument> = fields(storedValue, 5);

/**
 * An `_id` that is unique for `index`: an Int32, or an embedded document holding the
 * index under "n" plus other fields in random order (integer-like names among them).
 */
function idFor(index: number): fc.Arbitrary<unknown> {
  const embedded = fc
    .tuple(
      fc.uniqueArray(fc.tuple(fieldName, scalar), { maxLength: 3, selector: ([name]) => name }),
      fc.nat(3),
    )
    .map(([entries, position]) => {
      const others = entries.filter(([name]) => name !== "n");
      const at = Math.min(position, others.length);
      return new Map<string, unknown>([
        ...others.slice(0, at),
        ["n", new Int32(index)],
        ...others.slice(at),
      ]);
    });
  return fc.oneof(fc.constant(new Int32(index)), embedded);
}

/** One document: `_id` first (as the server stores it), then random fields. */
export function documentFor(
  index: number,
  extra?: [string, unknown],
): fc.Arbitrary<OrderedDocument> {
  return fc.tuple(idFor(index), fields(storedValue, 6), fc.nat(6)).map(([id, body, position]) => {
    const entries = [...body].filter(([name]) => name !== "_id" && name !== extra?.[0]);
    if (extra !== undefined) entries.splice(Math.min(position, entries.length), 0, extra);
    return new Map<string, unknown>([["_id", id], ...entries]);
  });
}

/**
 * A document that always triggers the problem, so every generated set does: integer-
 * like names after other names at the top level, in a nested document, in an array of
 * documents and in the `_id`.
 */
export function knownReorderedDocument(index: number, extra?: [string, unknown]): OrderedDocument {
  const document = new Map<string, unknown>([
    [
      "_id",
      new Map<string, unknown>([
        ["b", new Int32(1)],
        ["n", new Int32(index)],
        ["1", new Int32(2)],
      ]),
    ],
    ["b", new Int32(1)],
    ["7", "seven"],
    [
      "nested",
      new Map<string, unknown>([
        ["z", new Int32(1)],
        [
          "0",
          new Map<string, unknown>([
            ["y", true],
            ["3", null],
          ]),
        ],
      ]),
    ],
    [
      "list",
      [
        new Map<string, unknown>([
          ["k", "v"],
          ["2", new Int32(2)],
        ]),
      ],
    ],
  ]);
  if (extra !== undefined) document.set(extra[0], extra[1]);
  return document;
}

/**
 * `count` random documents with distinct `_id`s (numbered from `firstIndex`), plus
 * one `knownReorderedDocument`. `extra` adds a field (e.g. a tenant) to each.
 */
export function documentSet(
  count: { readonly min: number; readonly max: number },
  options: {
    readonly firstIndex?: number;
    readonly extra?: () => fc.Arbitrary<[string, unknown]>;
  } = {},
): fc.Arbitrary<OrderedDocument[]> {
  const firstIndex = options.firstIndex ?? 0;
  const extra = options.extra;
  return fc.integer({ min: count.min, max: count.max }).chain((size) => {
    const documents = Array.from({ length: size }, (_, offset) => {
      const index = firstIndex + offset;
      return extra === undefined
        ? documentFor(index)
        : extra().chain((field) => documentFor(index, field));
    });
    const known =
      extra === undefined
        ? fc.constant(knownReorderedDocument(firstIndex + size))
        : extra().map((field) => knownReorderedDocument(firstIndex + size, field));
    return fc.tuple(fc.tuple(...documents), known).map(([random, last]) => [...random, last]);
  });
}

/** The BSON bytes of a generated document, exactly in generated order. */
export function bytesOf(document: OrderedDocument): Buffer {
  return Buffer.from(BSON.serialize(document));
}

/** Raw documents in a canonical order (by bytes), for comparing two collections. */
export function sortedBytes(documents: readonly Uint8Array[]): Buffer[] {
  return documents.map((bytes) => Buffer.from(bytes)).sort(Buffer.compare);
}
