/** Tests for the JSON-lines logger. */

import { describe, expect, it } from "vitest";
import { createLogger, silentLogger } from "./logger.ts";

describe("createLogger", () => {
  it("writes one JSON object per line with level, message and fields", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line), { component: "op" });
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e");
    logger.child({ controller: "plan" }).info("c");

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error", "info"]);
    expect(parsed[1]).toMatchObject({ msg: "i", a: 1, component: "op" });
    expect(parsed[4]).toMatchObject({ msg: "c", component: "op", controller: "plan" });
    expect(typeof parsed[0]?.time).toBe("string");
  });

  it("drops lines below its level", () => {
    const lines: string[] = [];
    const logger = createLogger("warn", (line) => lines.push(line));
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(lines).toHaveLength(1);
  });

  it("has a silent variant", () => {
    expect(() => {
      silentLogger.info("x");
      silentLogger.child({}).error("y");
    }).not.toThrow();
  });
});
