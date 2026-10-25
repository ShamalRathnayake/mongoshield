import { MongoNetworkError, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoShieldError } from "../errors.ts";
import { isHistoryLost, toStreamError } from "./change-stream.ts";

describe("toStreamError", () => {
  const after = { t: 42, i: 7 };

  it("turns lost history into MS_CHANGE_HISTORY_LOST naming the resume point", () => {
    for (const code of [286, 280, 136]) {
      const error = toStreamError(new MongoServerError({ message: "gone", code }), after);
      expect(error.code).toBe("MS_CHANGE_HISTORY_LOST");
      expect(error.message).toContain("42:7");
      expect(isHistoryLost(error)).toBe(true);
    }
  });

  it("explains missing privileges and passes everything else on", () => {
    expect(toStreamError(new MongoServerError({ message: "no", code: 13 }), after).code).toBe(
      "MS_PERMISSION_DENIED",
    );
    const typed = new MongoShieldError("MS_TIMEOUT", "late");
    expect(toStreamError(typed, after)).toBe(typed);
    expect(toStreamError(new MongoNetworkError("reset"), after).code).toBe("MS_CONNECTION_FAILED");
    expect(toStreamError(new MongoServerError({ message: "x", code: 2 }), after).code).toBe(
      "MS_INTERNAL",
    );
    expect(isHistoryLost(new Error("plain"))).toBe(false);
  });
});
