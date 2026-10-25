// Unit tests for the inclusion/exclusion projections of `find`.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { compileProjection } from "./find-projection.ts";

const document = {
  _id: 1,
  name: "Ada",
  password: "secret",
  address: { city: "Oslo", zip: 123 },
  items: [{ sku: "a", qty: 1 }, 5, { qty: 2 }],
};

describe("compileProjection", () => {
  it("returns documents unchanged without a projection", () => {
    expect(compileProjection(undefined)(document)).toBe(document);
    expect(compileProjection({})(document)).toBe(document);
  });

  it("includes fields, dotted paths and array documents, keeping _id unless excluded", () => {
    expect(compileProjection({ name: 1, "address.city": 1, "items.sku": true })(document)).toEqual({
      _id: 1,
      name: "Ada",
      address: { city: "Oslo" },
      items: [{ sku: "a" }, {}],
    });
    expect(compileProjection({ name: 1, _id: 0 })(document)).toEqual({ name: "Ada" });
    expect(compileProjection({ address: 1, "address.city": 1 })(document)).toEqual({
      _id: 1,
      address: { city: "Oslo", zip: 123 },
    });
  });

  it("excludes fields and keeps everything else", () => {
    expect(compileProjection({ password: 0, "items.qty": 0, _id: false })(document)).toEqual({
      name: "Ada",
      address: { city: "Oslo", zip: 123 },
      items: [{ sku: "a" }, 5, {}],
    });
  });

  it("rejects mixed projections and projection operators", () => {
    for (const projection of [
      { name: 1, password: 0 },
      { items: { $slice: 1 } },
      { "items.$": 1 },
    ]) {
      let thrown: unknown;
      try {
        compileProjection(projection);
      } catch (error) {
        thrown = error;
      }
      expect(isMongoShieldError(thrown, "MS_CONFIG_INVALID")).toBe(true);
    }
  });
});
