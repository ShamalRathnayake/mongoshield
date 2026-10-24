// fromPino: adapting a pino-style `(fields, message)` logger to MongoShield's Logger.

import { describe, expect, it } from "vitest";
import { fromPino, type PinoLike, silentLogger } from "./logger.ts";

describe("fromPino", () => {
  it("swaps the argument order and passes empty fields when none are given", () => {
    const calls: [string, object, string][] = [];
    const record =
      (level: string) =>
      (fields: object, message: string): void => {
        calls.push([level, fields, message]);
      };
    const pino: PinoLike = {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    };
    const logger = fromPino(pino);
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e", { b: 2 });
    logger.info("i2");
    logger.debug("d2", { c: 3 });
    logger.warn("w2", { d: 4 });
    logger.error("e2");
    expect(calls).toEqual([
      ["debug", {}, "d"],
      ["info", { a: 1 }, "i"],
      ["warn", {}, "w"],
      ["error", { b: 2 }, "e"],
      ["info", {}, "i2"],
      ["debug", { c: 3 }, "d2"],
      ["warn", { d: 4 }, "w2"],
      ["error", {}, "e2"],
    ]);
  });

  it("offers a silent logger that does nothing", () => {
    expect(() => {
      silentLogger.debug("x");
      silentLogger.info("x");
      silentLogger.warn("x");
      silentLogger.error("x");
    }).not.toThrow();
  });
});
