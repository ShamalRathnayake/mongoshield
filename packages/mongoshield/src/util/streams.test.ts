// readStreamToBuffer: whole small objects into one Buffer, with a size cap.

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { readStreamToBuffer } from "./streams.ts";

describe("readStreamToBuffer", () => {
  it("joins Buffer and Uint8Array chunks", async () => {
    const stream = Readable.from([Buffer.from("ab"), new Uint8Array([99, 100])]);
    const bytes = await readStreamToBuffer(stream, { maxBytes: 10 });
    expect(bytes.toString("utf8")).toBe("abcd");
  });

  it("accepts a stream of exactly maxBytes", async () => {
    const bytes = await readStreamToBuffer(Readable.from([Buffer.alloc(4)]), { maxBytes: 4 });
    expect(bytes.length).toBe(4);
  });

  it("refuses a stream larger than maxBytes and destroys it", async () => {
    const stream = Readable.from([Buffer.alloc(3), Buffer.alloc(3), Buffer.alloc(3)]);
    const error: unknown = await readStreamToBuffer(stream, { maxBytes: 5 }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(stream.destroyed).toBe(true);
  });
});
