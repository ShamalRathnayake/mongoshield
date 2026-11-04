/**
 * Tests for the masked-copy check on collection definitions: validators, partial
 * index filters and view pipelines that refer to masked fields are reported, so a
 * copy can warn that values they quote reach the target unmasked.
 */

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { compileMask } from "../mask/index.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import { maskedDefinitionWarnings, warnAboutMaskedDefinitions } from "./copy-namespace.ts";

/** A collection spec with the given options and indexes. */
function spec(overrides: Partial<CollectionSpec> & Pick<CollectionSpec, "ns">): CollectionSpec {
  const [db = "", name = ""] = overrides.ns.split(".");
  return {
    db,
    name,
    type: "collection",
    options: {},
    indexes: [],
    estimatedDocuments: 0,
    ...overrides,
  };
}

const masks: Record<string, readonly string[]> = {
  "app.users": ["email", "addresses.*.street"],
};
const masksOf = (ns: string): readonly string[] => masks[ns] ?? [];

describe("maskedDefinitionWarnings", () => {
  it("finds masked fields in validators, including $jsonSchema properties", () => {
    const users = spec({
      ns: "app.users",
      options: {
        validator: {
          $or: [{ email: { $in: ["ceo@acme.com"] } }, { "addresses.0.street": "Main St 1" }],
          $jsonSchema: { properties: { email: { enum: ["cfo@acme.com"] } } },
        },
      },
    });
    expect(maskedDefinitionWarnings(users, masksOf)).toEqual([
      { ns: "app.users", where: "validator", fields: ["email", "addresses.*.street"] },
    ]);
  });

  it("finds masked fields in partial index filters", () => {
    const users = spec({
      ns: "app.users",
      indexes: [
        { v: 2, key: { _id: 1 }, name: "_id_" },
        { v: 2, key: { plan: 1 }, name: "vip", partialFilterExpression: { email: { $ne: "x" } } },
      ],
    });
    expect(maskedDefinitionWarnings(users, masksOf)).toEqual([
      { ns: "app.users", where: "index vip (partialFilterExpression)", fields: ["email"] },
    ]);
  });

  it("checks a view's pipeline against its source collection's rules", () => {
    const view = spec({
      ns: "app.vips",
      type: "view",
      options: {
        viewOn: "users",
        pipeline: [{ $match: { email: "ceo@acme.com" } }, { $project: { name: 1 } }],
      },
    });
    expect(maskedDefinitionWarnings(view, masksOf)).toEqual([
      { ns: "app.vips", where: "view pipeline", fields: ["email"] },
    ]);
    // Aggregation field paths count too; $$variables do not.
    const byReference = spec({
      ns: "app.domains",
      type: "view",
      options: { viewOn: "users", pipeline: [{ $project: { d: "$email", now: "$$NOW" } }] },
    });
    expect(maskedDefinitionWarnings(byReference, masksOf)[0]?.fields).toEqual(["email"]);
  });

  it("says nothing for definitions that only use unmasked fields", () => {
    const users = spec({ ns: "app.users", options: { validator: { plan: { $in: ["pro"] } } } });
    expect(maskedDefinitionWarnings(users, masksOf)).toEqual([]);
    expect(maskedDefinitionWarnings(spec({ ns: "app.orders" }), masksOf)).toEqual([]);
  });
});

describe("warnAboutMaskedDefinitions", () => {
  it("logs one warning per definition, naming the fields", () => {
    const mask = compileMask({
      secret: "a secret of some length!!",
      rules: { "app.users": { email: "redact" } },
    });
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const users = spec({ ns: "app.users", options: { validator: { email: { $in: ["a@b.c"] } } } });
    warnAboutMaskedDefinitions([{ spec: users }], mask, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(
      "The validator of app.users refers to masked field email",
    );
  });
});
