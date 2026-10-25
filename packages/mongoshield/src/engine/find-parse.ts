/**
 * Parsing backed-up documents for `find`, restore, copy and the read-side extras:
 * losslessly (an Int32 stays an `Int32`), and with the stored field order of embedded
 * documents whose field names look like integers.
 *
 * Why the second part: JavaScript objects always list integer-like keys ("0", "1")
 * first, so `BSON.deserialize` of `{ "b": 1, "0": 2 }` yields `{ "0": 2, "b": 1 }`. The
 * server compares embedded documents in stored order, so the filter evaluator needs
 * that order to decide `{ field: { b: 1, "0": 2 } }` like the server does, and every
 * write path needs it to put the document back byte for byte. The order is recorded
 * next to the parsed objects by src/format/field-order.ts (see its header), which
 * this file wraps with the error a damaged backup deserves.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { deserializeInStoredOrder } from "../format/field-order.ts";

/**
 * Parses one backed-up document losslessly and records the stored order of fields
 * that JavaScript would reorder.
 *
 * @throws MongoShieldError `MS_INTEGRITY_FAILED` when the bytes are not valid BSON
 *   (a damaged file).
 */
export function parseBackedUpDocument(raw: Uint8Array): Document {
  try {
    return deserializeInStoredOrder(raw);
  } catch (error) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `A backed-up document is not valid BSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, hint: "The backup is damaged. Run `mongoshield verify` on it." },
    );
  }
}
