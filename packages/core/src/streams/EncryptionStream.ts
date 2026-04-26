import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Applies on-the-fly AES-256-GCM encryption to the data stream.
 *
 * Cryptographic Architecture:
 * - A completely random 32-byte salt is generated for this specific stream.
 * - HKDF-SHA256 is used to derive a mathematically isolated 32-byte Stream Key from the Master Key + Salt.
 * - A 12-byte random IV is generated for AES-256-GCM.
 * - The stream is prepended with the [Salt (32 bytes)] + [IV (12 bytes)] so decryption can derive the exact same Stream Key.
 * - The 16-byte Auth Tag is appended to the tail of the stream to ensure perfect integrity.
 */
export class EncryptionTransform extends Transform {
  private cipher: ReturnType<typeof createCipheriv>;
  private iv: Buffer;
  private salt: Buffer;
  private isFirstChunk = true;

  constructor(masterKeyHex: string) {
    super();

    // Validate master key length
    const masterKeyBuffer = Buffer.from(masterKeyHex, "hex");
    if (masterKeyBuffer.length !== 32) {
      throw new Error(
        `Master encryption key must be exactly 32 bytes (64 hex characters) for AES-256. Received ${masterKeyBuffer.length} bytes.`,
      );
    }

    // 1. Generate 32-byte random salt for perfect key isolation
    this.salt = randomBytes(32);

    // 2. Derive a 32-byte Stream Key using HKDF-SHA256
    // We use a constant info string "mongoshield-stream-key" for context separation
    const streamKey = hkdfSync(
      "sha256",
      masterKeyBuffer,
      this.salt,
      "mongoshield-stream-key",
      32,
    );

    // 3. Generate 12-byte IV for GCM
    this.iv = randomBytes(12);

    // 4. Initialize the cipher with the derived Stream Key, NOT the master key directly
    this.cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(streamKey),
      this.iv,
    );
  }

  public override _transform(
    chunk: any,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      if (this.isFirstChunk) {
        // Prepend [Salt (32)] + [IV (12)] to the very beginning of the stream
        this.push(this.salt);
        this.push(this.iv);
        this.isFirstChunk = false;
      }

      const encryptedChunk = this.cipher.update(chunk);
      if (encryptedChunk.length > 0) {
        this.push(encryptedChunk);
      }
      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`Encryption failed: ${message}`));
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      const finalChunk = this.cipher.final();
      if (finalChunk.length > 0) {
        this.push(finalChunk);
      }

      // Append the 16-byte GCM authentication tag to the tail of the file
      const authTag = (this.cipher as any).getAuthTag();
      this.push(authTag);

      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`Encryption finalization failed: ${message}`));
    }
  }
}

/**
 * Reverses the AES-256-GCM encryption applied by EncryptionTransform.
 * Expects [Salt (32)] + [IV (12)] + [Encrypted Data] + [AuthTag (16)].
 */
export class DecryptionTransform extends Transform {
  private decipher: ReturnType<typeof createDecipheriv> | null = null;
  private masterKeyBuffer: Buffer;
  private headerBuffer: Buffer = Buffer.alloc(0);
  private tailBuffer: Buffer = Buffer.alloc(0);

  constructor(masterKeyHex: string) {
    super();
    this.masterKeyBuffer = Buffer.from(masterKeyHex, "hex");
    if (this.masterKeyBuffer.length !== 32) {
      throw new Error("Master encryption key must be exactly 32 bytes.");
    }
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let data = Buffer.concat([this.tailBuffer, chunk]);

      // 1. Extract Header (Salt + IV) if not already done
      if (!this.decipher) {
        const headerSize = 32 + 12;
        const currentTotalHeader = Buffer.concat([this.headerBuffer, data]);

        if (currentTotalHeader.length < headerSize) {
          this.headerBuffer = currentTotalHeader;
          callback();
          return;
        }

        const salt = currentTotalHeader.subarray(0, 32);
        const iv = currentTotalHeader.subarray(32, 44);
        data = currentTotalHeader.subarray(44);

        const streamKey = hkdfSync(
          "sha256",
          this.masterKeyBuffer,
          salt,
          "mongoshield-stream-key",
          32,
        );

        this.decipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(streamKey),
          iv,
        );
      }

      // 2. We must always keep the last 16 bytes in a tail buffer,
      // because they contain the GCM Auth Tag which we need for decipher.setAuthTag() at the end.
      const authTagSize = 16;
      if (data.length > authTagSize) {
        const toDecrypt = data.subarray(0, data.length - authTagSize);
        this.tailBuffer = data.subarray(data.length - authTagSize);

        const decrypted = this.decipher.update(toDecrypt);
        if (decrypted.length > 0) {
          this.push(decrypted);
        }
      } else {
        this.tailBuffer = data;
      }

      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`Decryption failed: ${message}`));
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      if (!this.decipher) {
        callback(new Error("Decryption failed: Stream too short (no header)"));
        return;
      }

      // The tail buffer now contains exactly the 16-byte Auth Tag
      if (this.tailBuffer.length !== 16) {
        callback(
          new Error("Decryption failed: Stream truncated (no auth tag)"),
        );
        return;
      }

      (this.decipher as any).setAuthTag(this.tailBuffer);

      const finalChunk = this.decipher.final();
      if (finalChunk.length > 0) {
        this.push(finalChunk);
      }
      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callback(new Error(`Decryption integrity check failed: ${message}`));
    }
  }
}
