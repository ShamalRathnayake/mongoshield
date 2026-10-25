/**
 * JSON and Extended JSON that keep the stored field order of documents, for the JSON
 * files MongoShield writes BSON values into: `<collection>.metadata.json` (index keys,
 * validators, partial filters, view pipelines) and the `_id` bounds and filters in
 * backup and copy checkpoints.
 *
 * The problem is the one src/format/field-order.ts solves for BSON: JavaScript objects
 * list integer-like keys ("0", "1", "42") first. `JSON.parse('{"b":1,"1":1}')` yields
 * `{ "1": 1, b: 1 }`, and `JSON.stringify` writes what the object lists. For an index
 * key that is a different index (`{ b: 1, "1": 1 }` is sorted by `b` first), for a view
 * a different `$sort`, for an `_id` bound a different position in the `_id` order.
 * `BSON.EJSON.parse` / `stringify` go through `JSON.parse` / `stringify` and lose the
 * order the same way.
 *
 * The approach: the same WeakMap of recorded field orders field-order.ts uses.
 *
 *   text ──parseJsonInStoredOrder──▶ plain JSON values, order recorded where it differs
 *        ──fromExtendedJson────────▶ BSON values (Int32, ObjectId, …), order kept
 *        ──(inStoredOrder / valueInStoredOrder right before the driver, as for documents)
 *
 *   BSON values ──toExtendedJson──▶ plain JSON values (canonical or relaxed), order kept
 *               ──stringifyJsonInStoredOrder──▶ text, documents written in stored order
 *
 * Everything else behaves exactly like the built-ins it replaces: for values without
 * integer-like keys the output is byte-identical to `JSON.stringify` /
 * `BSON.EJSON.stringify`, and parsing gives the same values as `JSON.parse` /
 * `BSON.EJSON.parse` (unit-tested against them on random input).
 *
 * Not kept: the order inside Extended JSON type wrappers whose content is itself a
 * document (`$code` with `$scope`, DBRef extra fields): they are handed to js-bson's
 * EJSON as a whole. Neither appears in index keys, validators, pipelines or `_id`s in
 * practice.
 */

import { BSON } from "mongodb";
import {
  containsStoredFieldOrder,
  entriesInStoredOrder,
  isIntegerLikeKey,
  isPlainDocument,
  recordStoredFieldOrder,
} from "./field-order.ts";

/** Options shared with `BSON.EJSON`: canonical (`relaxed: false`) or relaxed form. */
export interface ExtendedJsonOptions {
  readonly relaxed: boolean;
}

// ---------------------------------------------------------------------------
// Extended JSON
// ---------------------------------------------------------------------------

/**
 * `BSON.EJSON.parse(text, options)` that keeps the stored field order: documents
 * with integer-like keys get their order recorded (see field-order.ts).
 *
 * @throws SyntaxError for text that is not JSON, and whatever js-bson throws for
 *   malformed Extended JSON; callers wrap both in the error that fits their context.
 */
export function parseExtendedJson(text: string, options: ExtendedJsonOptions): unknown {
  return fromExtendedJson(parseJsonInStoredOrder(text), options);
}

/** `BSON.EJSON.stringify(value, options)` that writes documents in stored order. */
export function stringifyExtendedJson(value: unknown, options: ExtendedJsonOptions): string {
  return stringifyJsonInStoredOrder(toExtendedJson(value, options));
}

/**
 * `BSON.EJSON.deserialize` that keeps recorded field orders: turns plain JSON values
 * (as `parseJsonInStoredOrder` or `JSON.parse` returns them) into BSON values.
 *
 * Type wrappers (`{"$numberInt":"1"}`, `{"$oid":…}`, `{"$date":…}`, …) are recognized
 * by js-bson itself: an object with a `$` key is handed to `BSON.EJSON.deserialize`,
 * and when that returns something other than a plain document it was a wrapper. An
 * object with `$` keys that is not one (a query operator such as `{"$gt": …}`) and
 * every other object are rebuilt here, field by field in stored order, so the order
 * survives. That gives the same values as js-bson's own bottom-up parse.
 */
export function fromExtendedJson(value: unknown, options: ExtendedJsonOptions): unknown {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => fromExtendedJson(element, options));
  }
  if (typeof value === "number") {
    // A bare number stays a number in relaxed mode. In canonical mode js-bson makes it
    // an Int32, Long or Double; -0 is checked here because handing it to js-bson goes
    // through JSON.stringify, which writes it as "0".
    if (options.relaxed) return value;
    if (Object.is(value, -0)) return new BSON.Double(-0);
    return BSON.EJSON.deserialize(value as unknown as BSON.Document, options);
  }
  if (!isPlainDocument(value)) return value;

  if (Object.keys(value).some((name) => name.startsWith("$"))) {
    const converted: unknown = BSON.EJSON.deserialize(value, options);
    if (!isPlainDocument(converted)) return converted;
  }
  const document: BSON.Document = {};
  const names: string[] = [];
  for (const [name, child] of entriesInStoredOrder(value)) {
    // js-bson refuses such names when parsing (BSON cannot hold them); so does this.
    if (name.includes("\u0000")) {
      throw new BSON.BSONError(
        `BSON Document field names cannot contain null bytes, found: ${JSON.stringify(name)}`,
      );
    }
    setOwn(document, name, fromExtendedJson(child, options));
    names.push(name);
  }
  if (names.some(isIntegerLikeKey)) recordStoredFieldOrder(document, names);
  return document;
}

/**
 * `BSON.EJSON.serialize` that keeps the stored field order: turns BSON values into
 * plain JSON values, documents (plain objects with or without a recorded order, and
 * Maps) field by field. The result's order is recorded where JavaScript would change
 * it, for `stringifyJsonInStoredOrder`.
 */
export function toExtendedJson(value: unknown, options: ExtendedJsonOptions): unknown {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => {
      const converted = toExtendedJson(element, options);
      // JSON writes array holes and dropped values (functions) as null.
      return converted === undefined ? null : converted;
    });
  }
  let entries: Iterable<[string, unknown]>;
  if (value instanceof Map) entries = value as Map<string, unknown>;
  else if (isPlainDocument(value)) entries = entriesInStoredOrder(value);
  else return scalarToExtendedJson(value, options);

  const document: BSON.Document = {};
  const names: string[] = [];
  for (const [name, child] of entries) {
    const converted = toExtendedJson(child, options);
    // Values JSON cannot hold (functions, symbols) are left out, as EJSON does.
    if (converted === undefined) continue;
    setOwn(document, name, converted);
    names.push(name);
  }
  if (names.some(isIntegerLikeKey)) recordStoredFieldOrder(document, names);
  return document;
}

/**
 * Anything that is not a document or an array, in js-bson's Extended JSON form:
 * `Int32(1)` → `{"$numberInt":"1"}`, a Date → `{"$date":…}`, a string stays a string.
 * `BSON.EJSON.serialize` only takes documents, so the value is wrapped and unwrapped.
 */
function scalarToExtendedJson(value: unknown, options: ExtendedJsonOptions): unknown {
  const wrapped: BSON.Document = BSON.EJSON.serialize({ value }, options);
  return wrapped.value;
}

// ---------------------------------------------------------------------------
// Plain JSON
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify(value, null, space)` that writes objects with a recorded order
 * (from `parseJsonInStoredOrder` or `toExtendedJson`) in that order. Values without
 * one take the built-in, so ordinary files are written exactly as before.
 *
 * @param space indentation per level (as `JSON.stringify`'s numeric `space`), 0 for
 *   one line.
 */
export function stringifyJsonInStoredOrder(value: unknown, space = 0): string {
  if (!containsStoredFieldOrder(value)) return JSON.stringify(value, null, space);
  return writeJson(value, " ".repeat(space), "") ?? "null";
}

/**
 * One JSON value, formatted like `JSON.stringify` with the given indentation.
 * `undefined` for values JSON leaves out (functions, symbols, `undefined`).
 *
 * @param indent the indentation per level ("" for one line)
 * @param current the indentation of the line the value starts on
 */
function writeJson(value: unknown, indent: string, current: string): string | undefined {
  // Values with `toJSON` (Dates) are written as they ask, like JSON.stringify does.
  const plain: unknown = hasToJson(value) ? value.toJSON() : value;
  if (Array.isArray(plain)) {
    const inner = current + indent;
    const items = plain.map((element: unknown) => writeJson(element, indent, inner) ?? "null");
    return wrapItems("[", "]", items, indent, current);
  }
  if (!isPlainDocument(plain)) return JSON.stringify(plain);
  const inner = current + indent;
  const separator = indent === "" ? ":" : ": ";
  const items: string[] = [];
  for (const [name, child] of entriesInStoredOrder(plain)) {
    const written = writeJson(child, indent, inner);
    if (written !== undefined) items.push(`${JSON.stringify(name)}${separator}${written}`);
  }
  return wrapItems("{", "}", items, indent, current);
}

/** `[a,b]` / `{…}` on one line, or one item per indented line, as JSON.stringify does. */
function wrapItems(
  open: string,
  close: string,
  items: readonly string[],
  indent: string,
  current: string,
): string {
  if (items.length === 0) return `${open}${close}`;
  if (indent === "") return `${open}${items.join(",")}${close}`;
  const inner = current + indent;
  return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${current}${close}`;
}

function hasToJson(value: unknown): value is { toJSON(): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  );
}

/**
 * `JSON.parse(text)` that records the order of every object whose keys JavaScript
 * would list differently (integer-like keys after others); other objects are exactly
 * what `JSON.parse` returns. A small recursive-descent parser over RFC 8259 JSON;
 * strings and numbers are decoded by `JSON.parse` itself, so escapes and number forms
 * behave exactly like the built-in.
 *
 * @throws SyntaxError for text that is not JSON.
 */
export function parseJsonInStoredOrder(text: string): unknown {
  const parser = new JsonParser(text);
  const value = parser.value();
  parser.end();
  return value;
}

/** Characters JSON allows between tokens. */
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** A JSON number: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`. */
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The cursor over the text being parsed. */
class JsonParser {
  readonly #text: string;
  #position = 0;

  constructor(text: string) {
    this.#text = text;
  }

  /** Parses the value starting at the cursor (after whitespace). */
  value(): unknown {
    this.#skipWhitespace();
    const character = this.#text[this.#position];
    switch (character) {
      case "{":
        return this.#object();
      case "[":
        return this.#array();
      case '"':
        return this.#string();
      case "t":
        return this.#literal("true", true);
      case "f":
        return this.#literal("false", false);
      case "n":
        return this.#literal("null", null);
      default:
        return this.#number();
    }
  }

  /** Fails unless only whitespace is left. */
  end(): void {
    this.#skipWhitespace();
    if (this.#position < this.#text.length) this.#fail("Unexpected text after the JSON value");
  }

  /** `{ "name": value, … }`; the order is recorded when JavaScript would change it. */
  #object(): Record<string, unknown> {
    this.#position += 1; // "{"
    const document: Record<string, unknown> = {};
    const names: string[] = [];
    const seen = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#position] === "}") {
      this.#position += 1;
      return document;
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.#text[this.#position] !== '"') this.#fail("Expected a property name");
      const name = this.#string();
      this.#expect(":");
      setOwn(document, name, this.value());
      // A repeated name keeps its first position and its last value, like JSON.parse.
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      this.#skipWhitespace();
      const next = this.#text[this.#position];
      this.#position += 1;
      if (next === "}") break;
      if (next !== ",") this.#fail("Expected ',' or '}'", this.#position - 1);
    }
    if (names.some(isIntegerLikeKey)) recordStoredFieldOrder(document, names);
    return document;
  }

  /** `[ value, … ]`. */
  #array(): unknown[] {
    this.#position += 1; // "["
    const array: unknown[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#position] === "]") {
      this.#position += 1;
      return array;
    }
    for (;;) {
      array.push(this.value());
      this.#skipWhitespace();
      const next = this.#text[this.#position];
      this.#position += 1;
      if (next === "]") return array;
      if (next !== ",") this.#fail("Expected ',' or ']'", this.#position - 1);
    }
  }

  /** A string: finds its closing quote, then lets JSON.parse decode the escapes. */
  #string(): string {
    const start = this.#position;
    let cursor = start + 1;
    for (;;) {
      const character = this.#text[cursor];
      if (character === undefined) this.#fail("Unterminated string", start);
      if (character === '"') break;
      // Skip the escaped character, so `\"` does not end the string.
      cursor += character === "\\" ? 2 : 1;
    }
    this.#position = cursor + 1;
    return JSON.parse(this.#text.slice(start, cursor + 1)) as string;
  }

  #number(): number {
    JSON_NUMBER.lastIndex = this.#position;
    const match = JSON_NUMBER.exec(this.#text);
    if (match === null || match[0] === "" || match.index !== this.#position) {
      this.#fail("Unexpected token");
    }
    this.#position += match[0].length;
    return Number(match[0]);
  }

  #literal<T>(word: string, value: T): T {
    if (!this.#text.startsWith(word, this.#position)) this.#fail("Unexpected token");
    this.#position += word.length;
    return value;
  }

  #expect(character: string): void {
    this.#skipWhitespace();
    if (this.#text[this.#position] !== character) this.#fail(`Expected '${character}'`);
    this.#position += 1;
  }

  #skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.#text[this.#position] ?? "")) this.#position += 1;
  }

  #fail(message: string, at = this.#position): never {
    throw new SyntaxError(`${message} in JSON at position ${at}`);
  }
}

/**
 * Sets an own property, also for the name `__proto__` (an ordinary key in JSON, which
 * plain assignment would treat as the prototype), as `JSON.parse` does.
 */
function setOwn(document: Record<string, unknown>, name: string, value: unknown): void {
  if (name === "__proto__") {
    Object.defineProperty(document, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    document[name] = value;
  }
}
