import { createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EncryptionTransform } from "../../../src/streams/EncryptionStream";

describe("EncryptionTransform", () => {
  const masterKey = "0".repeat(64);

  it("throws on invalid key length", () => {
    expect(() => new EncryptionTransform("1234")).toThrow(
      "Master encryption key must be exactly 32 bytes",
    );
  });

  it("prepends salt (32) and IV (12) to the stream", () => {
    return new Promise<void>((resolve) => {
      const stream = new EncryptionTransform(masterKey);
      let received = Buffer.alloc(0);

      stream.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        // Stop after we have Salt + IV
        if (received.length >= 44) {
          stream.destroy();
          resolve();
        }
      });

      stream.write("some data");
    });
  });

  it("encrypts and can be decrypted correctly", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new EncryptionTransform(masterKey);
      const input = Buffer.alloc(1024, "a"); // 1KB of data
      let encrypted = Buffer.alloc(0);

      stream.on("data", (chunk) => {
        encrypted = Buffer.concat([encrypted, chunk]);
      });

      stream.on("end", () => {
        try {
          // Format: Salt(32) | IV(12) | Ciphertext (N) | Tag(16)
          const salt = encrypted.subarray(0, 32);
          const iv = encrypted.subarray(32, 44);
          const authTag = encrypted.subarray(encrypted.length - 16);
          const ciphertext = encrypted.subarray(44, encrypted.length - 16);

          const derivedKey = hkdfSync(
            "sha256",
            Buffer.from(masterKey, "hex"),
            salt,
            "mongoshield-stream-key",
            32,
          );

          const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
          decipher.setAuthTag(authTag);

          const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);

          expect(decrypted.length).toBe(input.length);
          expect(decrypted.equals(input)).toBe(true);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      stream.write(input);
      stream.end();
    });
  });

  it("handles transformation errors safely", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new EncryptionTransform(masterKey);

      // Corrupt internal cipher to force update() error
      vi.spyOn((stream as any).cipher, "update").mockImplementation(() => {
        throw new Error("Simulated cipher update error");
      });

      stream.on("error", (err) => {
        try {
          expect(err.message).toBe(
            "Encryption failed: Simulated cipher update error",
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on("data", () => {});

      stream.write("bad data");
    });
  });

  it("handles finalization errors safely", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new EncryptionTransform(masterKey);

      // Corrupt internal cipher to force final() error
      vi.spyOn((stream as any).cipher, "final").mockImplementation(() => {
        throw new Error("Simulated cipher final error");
      });

      stream.on("error", (err) => {
        try {
          expect(err.message).toBe(
            "Encryption finalization failed: Simulated cipher final error",
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on("data", () => {});

      stream.write("data");
      stream.end();
    });
  });

  it("pushes final chunk if it has length", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new EncryptionTransform(masterKey);
      const dataChunks: Buffer[] = [];
      stream.on("data", (c) => dataChunks.push(c));

      // Mock final to return some extra data
      const mockFinal = Buffer.from("extra-final-data");
      vi.spyOn((stream as any).cipher, "final").mockReturnValue(mockFinal);
      vi.spyOn((stream as any).cipher, "getAuthTag").mockReturnValue(
        Buffer.alloc(16),
      );

      stream.on("end", () => {
        try {
          const full = Buffer.concat(dataChunks);
          expect(full.toString()).toContain("extra-final-data");
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.write("data");
      stream.end();
    });
  });

  it("handles non-Error thrown during transformation", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new EncryptionTransform(masterKey);

      vi.spyOn((stream as any).cipher, "update").mockImplementation(() => {
        throw "String Error";
      });

      stream.on("error", (err) => {
        try {
          expect(err.message).toBe("Encryption failed: String Error");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on("data", () => {});

      stream.write("data");
    });
  });

  it("handles non-Error thrown during flush", () => {
    const stream = new EncryptionTransform(masterKey);
    vi.spyOn((stream as any).cipher, "final").mockImplementation(() => {
      throw "Flush Error";
    });

    return new Promise<void>((resolve) => {
      stream.on("error", (err) => {
        expect(err.message).toBe("Encryption finalization failed: Flush Error");
        resolve();
      });
      stream.end();
    });
  });

  it("hits the second chunk branch in _transform", () => {
    return new Promise<void>((resolve) => {
      const stream = new EncryptionTransform(masterKey);
      stream.on("data", () => {}); // Consume
      stream.on("end", resolve);

      stream.write("first");
      stream.write("second"); // Hits the false branch of isFirstChunk
      stream.end();
    });
  });
});
