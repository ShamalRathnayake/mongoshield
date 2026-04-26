import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_TYPE_BSON,
  MultiplexWriteStream,
} from "../../../src/streams/MultiplexWriteStream";

describe("MultiplexWriteStream", () => {
  it("wraps chunk with MSAF header and writes to destination atomically", () => {
    return new Promise<void>((resolve, reject) => {
      const writtenChunks: Buffer[] = [];
      const mockDestination = new Writable({
        write(chunk, encoding, callback) {
          writtenChunks.push(Buffer.from(chunk));
          callback();
        },
      });

      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );
      const payload = Buffer.from("hello payload");

      stream.write(payload, (error) => {
        if (error) return reject(error);

        try {
          expect(writtenChunks.length).toBe(1);
          const chunk = writtenChunks[0];

          // Header Layout Verification
          expect(chunk.readUInt8(0)).toBe(CHUNK_TYPE_BSON); // Type

          const nameLen = chunk.readUInt16LE(1);
          expect(nameLen).toBe(10); // "mydb.users".length

          const name = chunk.subarray(3, 3 + nameLen).toString("utf8");
          expect(name).toBe("mydb.users");

          const payloadLen = chunk.readUInt32LE(3 + nameLen);
          expect(payloadLen).toBe(payload.length);

          const writtenPayload = chunk.subarray(3 + nameLen + 4);
          expect(writtenPayload.toString()).toBe("hello payload");

          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("handles backpressure correctly", () => {
    return new Promise<void>((resolve, reject) => {
      const mockDestination = new Writable({
        write(chunk, encoding, callback) {
          // Simulate backpressure by not calling callback immediately, and returning false
          setTimeout(callback, 10);
          return false;
        },
      });

      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );

      let callbackFired = false;
      stream.write(Buffer.from("data"), () => {
        callbackFired = true;
        resolve();
      });

      expect(callbackFired).toBe(false);

      // Simulate drain event which should trigger the callback
      setTimeout(() => {
        mockDestination.emit("drain");
      }, 5);
    });
  });

  it("handles write errors safely", () => {
    return new Promise<void>((resolve, reject) => {
      const mockDestination = new Writable();
      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );

      // Handle the error event to prevent unhandled exception
      stream.on("error", () => {});

      // Corrupt internal state to trigger error in _write
      (stream as any).nameBuffer = null;

      stream.write(Buffer.from("data"), (error) => {
        try {
          expect(error).toBeDefined();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("handles string chunks and converts to Buffer", () => {
    return new Promise<void>((resolve) => {
      const mockDestination = {
        write: vi.fn().mockImplementation((chunk) => {
          // Chunk 1: header + 'data'
          // Header length: 1 + 2 + 10 + 4 = 17
          // Total length: 17 + 4 = 21
          expect(chunk.length).toBe(21);
          expect(chunk.toString().includes("data")).toBe(true);
          return true;
        }),
        once: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
      } as any;

      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );
      stream.write("data", "utf8", () => {
        resolve();
      });
    });
  });

  it("handles backpressure during header write", () => {
    return new Promise<void>((resolve) => {
      let drainListener: any = null;
      const mockDestination = {
        write: vi.fn().mockReturnValue(false),
        once: vi.fn().mockImplementation((event, cb) => {
          if (event === "drain") drainListener = cb;
        }),
        on: vi.fn(),
        emit: vi.fn(),
      } as any;

      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );

      stream.write(Buffer.from("data"), () => {
        resolve();
      });

      expect(mockDestination.once).toHaveBeenCalledWith(
        "drain",
        expect.any(Function),
      );
      // Simulate drain
      if (drainListener) drainListener();
    });
  });

  it("_final does not close destination stream", () => {
    return new Promise<void>((resolve) => {
      const mockDestination = new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
      });

      const destroySpy = vi.spyOn(mockDestination, "destroy");
      const endSpy = vi.spyOn(mockDestination, "end");

      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );

      stream.end(() => {
        expect(destroySpy).not.toHaveBeenCalled();
        expect(endSpy).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("handles non-Error objects in _write callback", () => {
    return new Promise<void>((resolve) => {
      const mockDestination = new Writable();
      const stream = new MultiplexWriteStream(
        mockDestination,
        CHUNK_TYPE_BSON,
        "mydb.users",
      );

      stream.on("error", (err) => {
        expect(err.message).toBe("String Error");
        resolve();
      });

      // Force an error that is not an Error object
      (stream as any).nameBuffer = {
        length: 0,
        copy: () => {
          throw "String Error";
        },
      };

      stream.write(Buffer.from("data"));
    });
  });
});
