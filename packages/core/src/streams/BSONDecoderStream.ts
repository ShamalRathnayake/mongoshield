import { Transform, type TransformCallback } from "node:stream";
import { BSON } from "mongodb";

/**
 * Transforms a raw binary BSON stream into JavaScript objects.
 * This is the inverse of BSONEncoderStream.
 */
export class BSONDecoderStream extends Transform {
  private buffer = Buffer.alloc(0);

  constructor() {
    super({
      writableObjectMode: false, // We accept raw binary Buffers
      readableObjectMode: true, // We emit JS/BSON Document objects
    });
  }

  public override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      // BSON documents have their size as a 32-bit integer in the first 4 bytes
      while (this.buffer.length >= 4) {
        const size = this.buffer.readInt32LE(0);

        if (size <= 0) {
          throw new Error(`Invalid BSON document size: ${size}`);
        }

        if (this.buffer.length >= size) {
          const docBuffer = this.buffer.subarray(0, size);
          this.buffer = this.buffer.subarray(size);

          const doc = BSON.deserialize(docBuffer);
          this.push(doc);
        } else {
          // Not enough data yet for the full document
          break;
        }
      }
      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`BSON Deserialization failed: ${message}`));
    }
  }

  public override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      callback(
        new Error(
          "BSON Deserialization failed: Stream ended with incomplete document",
        ),
      );
    } else {
      callback();
    }
  }
}
