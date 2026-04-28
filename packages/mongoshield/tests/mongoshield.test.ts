import { describe, expect, it } from "vitest";
import { MongoShield, MongoShieldConfigSchema, VERSION } from "../src/index";

describe("mongoshield wrapper package", () => {
  describe("MongoShield class", () => {
    it("should instantiate successfully with a valid URI", () => {
      const shield = new MongoShield({
        uri: "mongodb://localhost:27017/test",
      });
      expect(shield).toBeDefined();
      expect(shield).toBeInstanceOf(MongoShield);
    });

    it("should throw an error with an invalid URI format", () => {
      expect(() => new MongoShield({ uri: "not-a-uri" })).toThrow();
    });

    it("should default destination to 'local'", () => {
      const parsed = MongoShieldConfigSchema.parse({
        uri: "mongodb://localhost:27017/test",
      });
      expect(parsed.destination).toBe("local");
    });

    it("should accept valid destination values", () => {
      const parsed = MongoShieldConfigSchema.parse({
        uri: "mongodb://localhost:27017/test",
        destination: "s3",
      });
      expect(parsed.destination).toBe("s3");
    });

    it("should reject invalid destination values", () => {
      expect(() =>
        MongoShieldConfigSchema.parse({
          uri: "mongodb://localhost:27017/test",
          destination: "invalid",
        }),
      ).toThrow();
    });
  });

  describe("re-exports from @mongoshield/core", () => {
    it("should re-export the VERSION constant from core", () => {
      expect(VERSION).toBeDefined();
      expect(typeof VERSION).toBe("string");
    });
  });
});
