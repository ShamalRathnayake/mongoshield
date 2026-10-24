/**
 * `ssh2` is an optional peer dependency. This file simulates it being absent
 * (in its own module registry, so other tests keep the real package) and
 * checks that users get MS_CONFIG_INVALID with the install command as the hint.
 */

import { describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";

vi.mock("ssh2", () => {
  throw Object.assign(new Error("Cannot find package 'ssh2'"), { code: "ERR_MODULE_NOT_FOUND" });
});

describe("sftpStorage without ssh2 installed", () => {
  it("creates the adapter, then fails the first call with MS_CONFIG_INVALID and an install hint", async () => {
    const { sftpStorage } = await import("./sftp.ts");
    const storage = sftpStorage({
      host: "example.com",
      username: "backup",
      privateKey: "not used",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      path: "/srv/backups",
    });
    const error = await storage.head("a").catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBe("npm install ssh2");
  });
});
