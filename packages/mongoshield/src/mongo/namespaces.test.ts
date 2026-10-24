// Unit tests for namespace patterns, the include/exclude filter and restore ordering.
// Discovery against a real server is covered in test/integration/mongo-discovery.test.ts.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  type CollectionSpec,
  compileNamespaceFilter,
  orderForRestore,
  splitNamespace,
} from "./namespaces.ts";

/** Database-name characters: no dots (MongoDB forbids them) and no `*`. */
const databaseName = fc.stringMatching(/^[a-z0-9_-]{1,12}$/);
/** Collection names may contain dots. */
const collectionName = fc.stringMatching(/^[a-z0-9_-]{1,8}(\.[a-z0-9_-]{1,8}){0,3}$/);

describe("splitNamespace", () => {
  it("splits at the first dot so collection names keep their dots", () => {
    expect(splitNamespace("app.events.2024.q1")).toEqual({
      database: "app",
      collection: "events.2024.q1",
    });
  });

  it("treats a name without a dot as a database with an empty collection", () => {
    expect(splitNamespace("app")).toEqual({ database: "app", collection: "" });
  });
});

describe("compileNamespaceFilter", () => {
  it("includes everything when include is empty or missing", () => {
    expect(compileNamespaceFilter({})("app.users")).toBe(true);
    expect(compileNamespaceFilter({ include: [] })("x.y.z")).toBe(true);
  });

  it("matches exact namespaces only", () => {
    const filter = compileNamespaceFilter({ include: ["app.users"] });
    expect(filter("app.users")).toBe(true);
    expect(filter("app.users2")).toBe(false);
    expect(filter("app2.users")).toBe(false);
  });

  it("matches a whole database with db.*, including dotted collection names", () => {
    const filter = compileNamespaceFilter({ include: ["app.*"] });
    expect(filter("app.users")).toBe(true);
    expect(filter("app.events.2024")).toBe(true);
    expect(filter("apple.users")).toBe(false);
  });

  it("matches a collection name in every database with *.name", () => {
    const filter = compileNamespaceFilter({ include: ["*.sessions"] });
    expect(filter("app.sessions")).toBe(true);
    expect(filter("other.sessions")).toBe(true);
    expect(filter("app.sessions.old")).toBe(false);
    expect(filter("app.user_sessions")).toBe(false);
  });

  it("does not let a database wildcard swallow part of a dotted collection name", () => {
    // `*.b` must not match `a.x.b`: the database is `a` and the collection is `x.b`.
    const filter = compileNamespaceFilter({ include: ["*.b"] });
    expect(filter("a.x.b")).toBe(false);
    expect(compileNamespaceFilter({ include: ["*.x.b"] })("a.x.b")).toBe(true);
  });

  it("supports wildcards inside names", () => {
    const filter = compileNamespaceFilter({ include: ["*.audit_*", "shop_*.orders"] });
    expect(filter("app.audit_2024")).toBe(true);
    expect(filter("shop_eu.orders")).toBe(true);
    expect(filter("shop.orders")).toBe(false);
  });

  it("matches regex metacharacters literally", () => {
    const filter = compileNamespaceFilter({ include: ["app.a+b(c)"] });
    expect(filter("app.a+b(c)")).toBe(true);
    expect(filter("app.aab(c)")).toBe(false);
    expect(compileNamespaceFilter({ include: ["app.a.b"] })("app.aXb")).toBe(false);
  });

  it("lets exclude win over include", () => {
    const filter = compileNamespaceFilter({ include: ["app.*"], exclude: ["app.cache*", "*.tmp"] });
    expect(filter("app.users")).toBe(true);
    expect(filter("app.cache")).toBe(false);
    expect(filter("app.cache.v2")).toBe(false);
    expect(filter("app.tmp")).toBe(false);
  });

  it("applies exclude to everything when include is empty", () => {
    const filter = compileNamespaceFilter({ exclude: ["logs.*"] });
    expect(filter("logs.http")).toBe(false);
    expect(filter("app.logs")).toBe(true);
  });

  it("treats a bare * as matching every namespace", () => {
    const filter = compileNamespaceFilter({ include: ["*"] });
    expect(filter("admin.system.users")).toBe(true);
    expect(compileNamespaceFilter({ exclude: ["*"] })("app.users")).toBe(false);
  });

  it.each([
    ["", "empty"],
    ["app", "no dot"],
    ["*app", "wildcard without a dot"],
    [".users", "empty database"],
    ["app.", "empty collection"],
    ["my app.users", "space in database"],
    ["a$b.users", "dollar in database"],
    ["a/b.users", "slash in database"],
    ["app.us\0ers", "NUL in collection"],
  ])("rejects the pattern %j (%s) with MS_CONFIG_INVALID", (pattern) => {
    let caught: unknown;
    try {
      compileNamespaceFilter({ include: [pattern] });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("validates exclude patterns too", () => {
    expect(() => compileNamespaceFilter({ exclude: ["nodot"] })).toThrow(
      /Invalid namespace pattern/,
    );
  });

  it("explains how to select a whole database when the dot is missing", () => {
    expect(() => compileNamespaceFilter({ include: ["app"] })).toThrow(/app\.\*/);
  });

  it("property: an exact pattern matches exactly its own namespace", () => {
    fc.assert(
      fc.property(
        databaseName,
        collectionName,
        databaseName,
        collectionName,
        (db, coll, db2, coll2) => {
          const filter = compileNamespaceFilter({ include: [`${db}.${coll}`] });
          expect(filter(`${db}.${coll}`)).toBe(true);
          expect(filter(`${db2}.${coll2}`)).toBe(db === db2 && coll === coll2);
        },
      ),
    );
  });

  it("property: db.* matches exactly the namespaces of that database", () => {
    fc.assert(
      fc.property(databaseName, databaseName, collectionName, (db, otherDb, coll) => {
        const filter = compileNamespaceFilter({ include: [`${db}.*`] });
        expect(filter(`${otherDb}.${coll}`)).toBe(db === otherDb);
      }),
    );
  });

  it("property: *.name matches that collection name in any database", () => {
    fc.assert(
      fc.property(databaseName, collectionName, collectionName, (db, coll, otherColl) => {
        const filter = compileNamespaceFilter({ include: [`*.${coll}`] });
        expect(filter(`${db}.${otherColl}`)).toBe(coll === otherColl);
      }),
    );
  });

  it("property: excluding a namespace always removes it", () => {
    fc.assert(
      fc.property(databaseName, collectionName, (db, coll) => {
        const ns = `${db}.${coll}`;
        expect(compileNamespaceFilter({ include: ["*"], exclude: [ns] })(ns)).toBe(false);
      }),
    );
  });
});

/** Builds a minimal spec for ordering tests. */
function spec(ns: string, type: CollectionSpec["type"], viewOn?: string): CollectionSpec {
  const { database, collection } = splitNamespace(ns);
  return {
    ns,
    db: database,
    name: collection,
    type,
    options: viewOn === undefined ? {} : { viewOn, pipeline: [] },
    indexes: [],
    estimatedDocuments: 0,
  };
}

describe("orderForRestore", () => {
  it("puts collections and time series before views, keeping their order", () => {
    const ordered = orderForRestore([
      spec("app.a_view", "view", "users"),
      spec("app.metrics", "timeseries"),
      spec("app.users", "collection"),
    ]);
    expect(ordered.map((entry) => entry.ns)).toEqual(["app.metrics", "app.users", "app.a_view"]);
  });

  it("places a view after the view it is defined on", () => {
    const ordered = orderForRestore([
      spec("app.a_top", "view", "m_middle"),
      spec("app.m_middle", "view", "z_base"),
      spec("app.z_base", "view", "users"),
      spec("app.users", "collection"),
    ]);
    expect(ordered.map((entry) => entry.ns)).toEqual([
      "app.users",
      "app.z_base",
      "app.m_middle",
      "app.a_top",
    ]);
  });

  it("resolves viewOn within the view's own database", () => {
    const ordered = orderForRestore([
      spec("a.v2", "view", "v1"),
      spec("b.v1", "view", "c"),
      spec("a.v1", "view", "c"),
    ]);
    expect(ordered.map((entry) => entry.ns)).toEqual(["a.v1", "a.v2", "b.v1"]);
  });

  it("rejects views that form a cycle with MS_MANIFEST_INVALID", () => {
    const specs = [spec("app.v1", "view", "v2"), spec("app.v2", "view", "v1")];
    expect(() => orderForRestore(specs)).toThrow(/cycle: app\.v1 → app\.v2 → app\.v1/);
    try {
      orderForRestore(specs);
    } catch (error) {
      expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    }
  });

  it("property: every view comes after the view it reads from", () => {
    // Random forests of views: view i reads from a collection or an earlier view.
    const forest = fc
      .array(fc.nat(), { minLength: 1, maxLength: 15 })
      .map((parents) =>
        parents.map((parent, index) =>
          spec(
            `db.v${index}`,
            "view",
            index === 0 || parent % 3 === 0 ? "base" : `v${parent % index}`,
          ),
        ),
      );
    fc.assert(
      fc.property(forest, fc.boolean(), (views, reverse) => {
        // Reversed input lists every view before its source: the worst case for ordering.
        const input = reverse ? [...views].reverse() : views;
        const ordered = orderForRestore([...input, spec("db.base", "collection")]);
        const position = new Map(ordered.map((entry, index) => [entry.ns, index]));
        expect(ordered).toHaveLength(views.length + 1);
        for (const view of views) {
          const source = `db.${String(view.options.viewOn)}`;
          expect(position.get(source)).toBeLessThan(position.get(view.ns) ?? -1);
        }
      }),
    );
  });
});
