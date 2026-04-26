import * as BSON from "bson";
import { describe, expect, it, vi } from "vitest";
import { BSONEncoderStream } from "../../../src/streams/BSONEncoderStream";

describe("BSONEncoderStream", () => {
  it("serializes a JS object to BSON buffer", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new BSONEncoderStream();
      const input = { hello: "world" };

      stream.on("data", (chunk) => {
        try {
          const decoded = BSON.deserialize(chunk);
          expect(decoded).toEqual(input);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.write(input);
    });
  });

  it("emits an error on serialization failure (circular)", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new BSONEncoderStream();
      const circular: any = {};
      circular.self = circular;

      stream.on("error", (err) => {
        try {
          expect(err.message).toMatch(/BSON Serialization failed/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.write(circular);
    });
  });

  it("handles non-Error thrown during serialization", () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new BSONEncoderStream();

      // BSON.serialize will call getters. By throwing a string from a getter,
      // we can trigger the non-Error catch block in BSONEncoderStream.
      const badObj = {};
      Object.defineProperty(badObj, "fail", {
        get: () => {
          throw "String Error";
        },
        enumerable: true,
      });

      stream.on("error", (err) => {
        try {
          expect(err.message).toBe("BSON Serialization failed: String Error");
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.write(badObj);
    });
  });
});
