import { describe, expect, it } from "vitest";
import { generateIdentity, identityToRecipient, parseIdentityFile } from "../crypto/index.ts";
import { formatIdentityFile } from "./backup-key.ts";

describe("formatIdentityFile", () => {
  it("writes an age-keygen style key file that parses back to the identity", () => {
    const generated = generateIdentity();
    const text = formatIdentityFile(generated, new Date("2026-11-14T03:00:04.123Z"));
    expect(text).toBe(
      `# created: 2026-11-14T03:00:04Z\n# public key: ${generated.recipient}\n${generated.identity}\n`,
    );
    const [identity] = parseIdentityFile(text);
    expect(identity).toBe(generated.identity);
    expect(identityToRecipient(identity ?? "")).toBe(generated.recipient);
  });
});
