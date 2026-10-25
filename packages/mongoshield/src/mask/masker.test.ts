import fc from "fast-check";
import { BSON, type Document, Int32, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../logger.ts";
import { defineMask, type MaskConfig } from "./config.ts";
import { compileMask } from "./masker.ts";

const secret = "a test secret that is long enough";

/** A logger that remembers warnings. */
function recordingLogger(): Logger & { warnings: { message: string; fields?: LogFields }[] } {
  const warnings: { message: string; fields?: LogFields }[] = [];
  const noop = () => {};
  return {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (message, fields) => warnings.push({ message, ...(fields ? { fields } : {}) }),
  };
}

/** Masks one document of `ns` with `config`. */
function maskOne(config: MaskConfig, ns: string, document: Document): Document {
  const mask = compileMask(config);
  return mask.forNamespace(ns)?.apply(structuredClone(document)) ?? document;
}

describe("compileMask", () => {
  it("applies every operation", () => {
    const masked = maskOne(
      {
        secret,
        rules: {
          "app.users": {
            email: { fake: "email" },
            name: "hash",
            ssn: "null",
            password: "drop",
            notes: "redact",
            bio: { redact: "[gone]" },
            plan: "keep",
            score: (value) => (typeof value === "number" ? Math.round(value / 10) * 10 : value),
          },
        },
      },
      "app.users",
      {
        email: "ada@lovelace.org",
        name: "Ada",
        ssn: "123",
        password: "x",
        notes: "secret",
        bio: "long",
        plan: "pro",
        score: 87,
      },
    );
    expect(masked.email).toMatch(/@example\.(com|net|org)$/);
    expect(masked.name).toMatch(/^[a-z2-7]{16}$/);
    expect(masked.ssn).toBeNull();
    expect("password" in masked).toBe(false);
    expect(masked.notes).toBe("[redacted]");
    expect(masked.bio).toBe("[gone]");
    expect(masked.plan).toBe("pro");
    expect(masked.score).toBe(90);
  });

  it("masks both sides of a reference identically, so joins keep working", () => {
    const mask = compileMask({
      secret,
      rules: {
        "app.users": { _id: "hash", email: { fake: "email" } },
        "app.orders": { userId: "hash", buyerEmail: { fake: "email" } },
      },
    });
    fc.assert(
      fc.property(fc.integer(), fc.emailAddress(), (id, email) => {
        const user = mask.forNamespace("app.users")?.apply({ _id: new Int32(id | 0), email });
        const order = mask
          .forNamespace("app.orders")
          ?.apply({ _id: new ObjectId(), userId: new Int32(id | 0), buyerEmail: email });
        expect(BSON.EJSON.stringify(order?.userId)).toBe(BSON.EJSON.stringify(user?._id));
        expect(order?.buyerEmail).toBe(user?.email);
      }),
    );
  });

  it("goes into arrays element by element for hash, fake and redact", () => {
    const masked = maskOne(
      {
        secret,
        rules: {
          "app.users": { tags: "hash", "addresses.*.city": "redact", emails: { fake: "email" } },
        },
      },
      "app.users",
      { tags: ["a", "b"], addresses: [{ city: "x" }, { city: "y" }], emails: ["a@b.c", null] },
    );
    expect(masked.tags).toHaveLength(2);
    expect(masked.tags[0]).toMatch(/^[a-z2-7]{16}$/);
    expect(masked.addresses).toEqual([{ city: "[redacted]" }, { city: "[redacted]" }]);
    expect(masked.emails[1]).toBeNull();
  });

  it("lets an exact namespace override a broader pattern for the same path", () => {
    const config = defineMask({
      secret,
      rules: { "*.*": { email: "redact" }, "app.admins": { email: "keep" } },
    });
    expect(maskOne(config, "app.users", { email: "a@b.c" }).email).toBe("[redacted]");
    expect(maskOne(config, "app.admins", { email: "a@b.c" }).email).toBe("a@b.c");
  });

  it("leaves namespaces without rules alone", () => {
    const mask = compileMask({ secret, rules: { "app.users": { email: "redact" } } });
    expect(mask.forNamespace("app.orders")).toBeUndefined();
  });

  it("leaves unsupported values unchanged with one warning per rule and type", () => {
    const logger = recordingLogger();
    const mask = compileMask({ secret, rules: { "app.users": { flag: "hash" } } }, { logger });
    const users = mask.forNamespace("app.users");
    expect(users?.apply({ flag: true }).flag).toBe(true);
    expect(users?.apply({ flag: false }).flag).toBe(false);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.fields).toMatchObject({ type: "bool", operation: "hash" });
    expect(mask.report().rules[0]?.unsupported).toEqual({ bool: 2 });
  });

  it("nulls or refuses unsupported values when asked to", () => {
    const nulled = maskOne(
      { secret, onUnsupported: "null", rules: { "app.users": { born: "hash" } } },
      "app.users",
      { born: new Date() },
    );
    expect(nulled.born).toBeNull();
    expect(() =>
      maskOne(
        { secret, onUnsupported: "fail", rules: { "app.users": { born: "hash" } } },
        "app.users",
        {
          born: new Date(),
        },
      ),
    ).toThrow(/cannot mask a date value/);
  });

  it("gives custom functions deterministic helpers and removes fields they return undefined for", () => {
    const masked = maskOne(
      {
        secret,
        rules: {
          "app.users": {
            nickname: (value, context) => context.hash(value),
            secretField: () => undefined,
            ref: (value, context) => `${context.ns}:${context.path}:${String(value)}`,
          },
        },
      },
      "app.users",
      { nickname: "ada", secretField: 1, ref: 5 },
    );
    expect(masked.nickname).toBe(
      maskOne({ secret, rules: { "app.users": { nickname: "hash" } } }, "app.users", {
        nickname: "ada",
      }).nickname,
    );
    expect("secretField" in masked).toBe(false);
    expect(masked.ref).toBe("app.users:ref:5");
  });

  it("fails closed when a custom function throws", () => {
    expect(() =>
      maskOne(
        {
          secret,
          rules: {
            "app.users": {
              email: () => {
                throw new Error("boom");
              },
            },
          },
        },
        "app.users",
        { email: "a@b.c" },
      ),
    ).toThrow(/custom mask "app.users → email" failed.*boom/);
  });

  it("warns about rules that never matched a value or a namespace", () => {
    const logger = recordingLogger();
    const mask = compileMask(
      { secret, rules: { "app.users": { emial: "redact" }, "other.*": { x: "drop" } } },
      { logger },
    );
    mask.forNamespace("app.users")?.apply({ email: "a@b.c" });
    mask.finish();
    expect(logger.warnings.map((warning) => warning.message)).toEqual([
      "A mask rule never matched any document; check the field path",
      "A mask rule's pattern matched no copied namespace",
    ]);
  });

  it("reports what each rule did", () => {
    const mask = compileMask({ secret, rules: { "app.*": { email: { fake: "email" } } } });
    mask.forNamespace("app.users")?.apply({ email: "a@b.c" });
    mask.forNamespace("app.staff")?.apply({ email: "d@e.f" });
    expect(mask.report().rules).toEqual([
      {
        pattern: "app.*",
        path: "email",
        operation: "fake:email",
        namespaces: ["app.staff", "app.users"],
        values: 2,
        unsupported: {},
      },
    ]);
  });

  it("requires a long enough secret only when a rule needs one", () => {
    expect(() => compileMask({ rules: { "app.users": { email: "hash" } } })).toThrow(
      /need a secret/,
    );
    expect(() =>
      compileMask({ secret: "short", rules: { "app.users": { email: "hash" } } }),
    ).toThrow(/at least 16 characters/);
    expect(() => compileMask({ rules: { "app.users": { email: "redact" } } })).not.toThrow();
  });

  it.each([
    [{ rules: { "app.users": { email: "scramble" } } }, /unknown operation "scramble"/],
    [{ rules: { "app.users": { email: { fake: "ssn" } } } }, /unknown fake kind "ssn"/],
    [{ rules: { "app.users": { age: { hash: { range: [9, 1] } } } } }, /range must be/],
    [
      { rules: { "app.users": { born: { fake: "email", days: 3 } } } },
      /days applies to date-shift/,
    ],
    [{ rules: { "app.users": { "a..b": "drop" } } }, /Invalid field path/],
    [{ rules: { users: { a: "drop" } } }, /Invalid namespace pattern/],
    [{ rules: { "app.users": { a: "drop" } }, onUnsupported: "ignore" }, /onUnsupported/],
  ])("rejects invalid config %#", (config, message) => {
    expect(() => compileMask({ secret, ...(config as MaskConfig) })).toThrow(message);
  });
});
