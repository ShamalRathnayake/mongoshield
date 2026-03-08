import { describe, it, expect } from "vitest";
import { MongoShield } from "./MongoShield";

describe("MongoShield", () => {
  it("should instantiate successfully with a valid URI", () => {
    const shield = new MongoShield({ uri: "mongodb://localhost:27017/test" });
    expect(shield).toBeDefined();
    expect(shield).toBeInstanceOf(MongoShield);
  });

  it("should throw an error with an invalid URI format", () => {
    expect(() => new MongoShield({ uri: "not-a-uri" })).toThrow();
  });
});
