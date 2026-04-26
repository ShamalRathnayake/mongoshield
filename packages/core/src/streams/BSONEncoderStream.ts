import { Transform, type TransformCallback } from "node:stream";
import { BSON } from "mongodb";

/**
 * Transforms JavaScript objects emitted by a MongoDB cursor
 * into raw BSON binary buffers. This ensures output files can
 * be natively ingested by `mongorestore`.
 */
export class BSONEncoderStream extends Transform {
  constructor() {
    super({
      writableObjectMode: true, // We accept JS/BSON Document objects
      readableObjectMode: false, // We emit raw binary Buffers
    });
  }

  public override _transform(
    chunk: any,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const buffer = BSON.serialize(chunk);
      this.push(buffer);
      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`BSON Serialization failed: ${message}`));
    }
  }
}
