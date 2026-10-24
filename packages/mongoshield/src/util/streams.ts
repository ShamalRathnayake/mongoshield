/**
 * Small stream helpers shared across modules.
 */

import type { Readable } from "node:stream";
import { MongoShieldError } from "../errors.ts";

export interface ReadToBufferOptions {
  /**
   * Refuse to read more than this many bytes. Protects against loading a huge
   * object into memory by mistake (for example a data file instead of a manifest).
   */
  readonly maxBytes: number;
}

/**
 * Reads a whole stream into one Buffer. Only for small objects such as
 * manifests and metadata files; data files must always be streamed.
 */
export async function readStreamToBuffer(
  stream: Readable,
  options: ReadToBufferOptions,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > options.maxBytes) {
      stream.destroy();
      throw new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `Object is larger than the expected maximum of ${options.maxBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}
