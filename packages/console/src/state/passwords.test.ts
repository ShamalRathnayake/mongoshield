import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD_COST,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "./passwords.ts";

describe("password hashing", () => {
  it("uses scrypt with N = 2^17 by default", async () => {
    expect(DEFAULT_PASSWORD_COST).toBe(17);
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery staple", 14);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same", 14)).not.toBe(await hashPassword("same", 14));
  });

  it("rejects malformed, empty and downgraded hashes without throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    const hash = await hashPassword("x", 14);
    expect(await verifyPassword("x", hash.replace("scrypt$14$", "scrypt$4$"))).toBe(false);
    expect(await verifyPassword("x", hash.replace("scrypt$14$", "scrypt$30$"))).toBe(false);
  });

  it("spends time on unknown users and always fails", async () => {
    expect(await verifyAgainstDummy("anything", 14)).toBe(false);
  });
});
