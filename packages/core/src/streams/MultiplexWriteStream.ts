import { Writable } from "node:stream";

export const CHUNK_TYPE_BSON = 0x01;
export const CHUNK_TYPE_META = 0x02;
export const CHUNK_TYPE_EOF = 0xff;

/**
 * Wraps chunks of data in the MongoShield Archive Format (MSAF) header
 * and atomically pushes them to a shared destination stream.
 */
export class MultiplexWriteStream extends Writable {
  private nameBuffer: Buffer;

  constructor(
    private destination: Writable,
    private chunkType: number,
    name: string,
  ) {
    super({ decodeStrings: false });
    this.nameBuffer = Buffer.from(name, "utf8");

    // Forward errors from the shared destination to this stream
    this.destination.on("error", (err) => {
      this.destroy(err);
    });
  }

  public override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const payload = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);

      // Header layout:
      // Type (1 byte)
      // Name Length (2 bytes, UInt16LE)
      // Name (N bytes)
      // Payload Length (4 bytes, UInt32LE)

      const headerLength = 1 + 2 + this.nameBuffer.length + 4;
      const header = Buffer.alloc(headerLength);

      header.writeUInt8(this.chunkType, 0);
      header.writeUInt16LE(this.nameBuffer.length, 1);
      this.nameBuffer.copy(header, 3);
      header.writeUInt32LE(payload.length, 3 + this.nameBuffer.length);

      // Concatenate header and payload to ensure atomic write to the shared destination
      const atomicChunk = Buffer.concat([header, payload]);

      // Write to destination
      const canContinue = this.destination.write(atomicChunk);

      if (!canContinue) {
        // Handle backpressure
        this.destination.once("drain", callback);
      } else {
        callback();
      }
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public override _final(callback: (error?: Error | null) => void): void {
    // We do NOT close the destination stream here, because other multiplex streams
    // might still be writing to it. The ArchiveProvider manages the EOF.
    callback();
  }
}
