import { BSON, MongoNetworkError, MongoServerError, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoShieldError } from "../errors.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import { createCaptureScope, toCaptureError } from "./converge-capture.ts";
import { parseChangeEvent } from "./converge-events.ts";

const event = (fields: Record<string, unknown>) =>
  parseChangeEvent(BSON.serialize({ clusterTime: new Timestamp({ t: 1, i: 1 }), ...fields }));

function spec(ns: string): CollectionSpec {
  const [db = "", name = ""] = ns.split(/\.(.*)/s);
  return { ns, db, name, type: "collection", options: {}, indexes: [], estimatedDocuments: 0 };
}

describe("createCaptureScope", () => {
  const scope = createCaptureScope([spec("app.users"), spec("admin.settings")], {
    include: ["app.*", "admin.settings"],
    exclude: ["app.audit"],
  });

  it("keeps the backed-up namespaces and collections the patterns select", () => {
    expect(scope.keepsNamespace("app.users")).toBe(true);
    expect(scope.keepsNamespace("app.created_later")).toBe(true);
    expect(scope.keepsNamespace("admin.settings")).toBe(true);
    expect(scope.keepsNamespace("app.audit")).toBe(false);
    expect(scope.keepsNamespace("other.things")).toBe(false);
  });

  it("keeps scratch collections of backed-up databases, never system collections", () => {
    expect(scope.keepsNamespace("app.tmp.agg_out.1")).toBe(true);
    expect(scope.keepsNamespace("other.tmp.agg_out.1")).toBe(false);
    expect(scope.keepsNamespace("app.system.views")).toBe(false);
    expect(
      createCaptureScope([], { include: undefined, exclude: undefined }).keepsNamespace(
        "config.system.sessions",
      ),
    ).toBe(false);
    expect(
      createCaptureScope([], { include: undefined, exclude: undefined }).keepsNamespace(
        "local.oplog.rs",
      ),
    ).toBe(false);
  });

  it("keeps dropDatabase of user databases and renames into kept namespaces", () => {
    expect(scope.keeps(event({ operationType: "dropDatabase", ns: { db: "app" } }))).toBe(true);
    expect(scope.keeps(event({ operationType: "dropDatabase", ns: { db: "local" } }))).toBe(false);
    expect(scope.keeps(event({ operationType: "dropDatabase" }))).toBe(false);
    expect(scope.keeps(event({ operationType: "insert", ns: { db: "app" } }))).toBe(false);
    const into = { operationType: "rename", ns: { db: "other", coll: "x" } };
    expect(scope.keeps(event({ ...into, to: { db: "app", coll: "users" } }))).toBe(true);
    expect(scope.keeps(event({ ...into, to: { db: "other", coll: "y" } }))).toBe(false);
    expect(scope.keeps(event({ ...into }))).toBe(false);
    expect(scope.keeps(event({ operationType: "insert", ns: { db: "other", coll: "x" } }))).toBe(
      false,
    );
  });

  it("asks the server only for the databases the patterns name", () => {
    expect(scope.serverFilter).toEqual({
      $or: [{ "ns.db": { $in: ["admin", "app"] } }, { "to.db": { $in: ["admin", "app"] } }],
    });
    expect(
      createCaptureScope([spec("app.users")], { include: ["*.users"], exclude: undefined })
        .serverFilter,
    ).toEqual({
      "ns.db": { $nin: ["admin", "config", "local"] },
    });
  });
});

describe("toCaptureError", () => {
  const from = { t: 5, i: 1 };

  it("explains lost history and missing privileges", () => {
    for (const code of [286, 280, 136]) {
      const error = toCaptureError(new MongoServerError({ message: "gone", code }), from);
      expect(error.code).toBe("MS_CHANGE_HISTORY_LOST");
      expect(error.message).toContain("5:1");
      expect(error.details?.serverCode).toBe(code);
    }
    const denied = toCaptureError(new MongoServerError({ message: "no", code: 13 }), from);
    expect(denied.code).toBe("MS_PERMISSION_DENIED");
  });

  it("passes typed errors through and translates the rest like backup errors", () => {
    const typed = new MongoShieldError("MS_TIMEOUT", "late");
    expect(toCaptureError(typed, from)).toBe(typed);
    expect(toCaptureError(new MongoNetworkError("reset"), from).code).toBe("MS_CONNECTION_FAILED");
    expect(toCaptureError(new MongoServerError({ message: "x", code: 2 }), from).code).toBe(
      "MS_INTERNAL",
    );
    expect(toCaptureError("weird", from).code).toBe("MS_INTERNAL");
  });
});
