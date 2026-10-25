/**
 * Tests for redacted previews and error-text scrubbing.
 */

import { describe, expect, it } from "vitest";
import { redactUrlToOrigin, scrubText } from "./redact.ts";

describe("redactUrlToOrigin", () => {
  it("keeps only the origin of a URL", () => {
    expect(redactUrlToOrigin("https://hooks.slack.com/services/T0/B0/xyz")).toBe(
      "https://hooks.slack.com/***",
    );
  });

  it("hides a value that is not a URL entirely", () => {
    expect(redactUrlToOrigin("not a url with a token")).toBe("***");
  });
});

describe("scrubText", () => {
  it("removes passwords from MongoDB URIs anywhere in a message", () => {
    expect(
      scrubText('failed: connect to "mongodb+srv://app:hunter2@db.example.net/x" timed out'),
    ).toBe('failed: connect to "mongodb+srv://app:***@db.example.net/x" timed out');
    expect(scrubText("mongodb://onlyuser@db/")).toBe("mongodb://onlyuser:***@db/");
  });

  it("replaces every known secret with ***", () => {
    expect(scrubText("passphrase was correct-horse-battery", ["correct-horse-battery"])).toBe(
      "passphrase was ***",
    );
  });
});
