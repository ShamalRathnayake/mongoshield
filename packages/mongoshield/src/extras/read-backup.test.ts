import { describe, expect, it } from "vitest";
import type { Manifest } from "../format/manifest.ts";
import { assertNamespace, documentNamespace, manifestOf, parseRawDocument } from "./read-backup.ts";

/** Just the manifest fields `documentNamespace` reads. */
function manifestWith(namespaces: { ns: string; type: string }[]): Manifest {
  return {
    namespaces: namespaces.map(({ ns, type }) => ({
      ns,
      db: ns.split(".")[0],
      collection: ns.slice(ns.indexOf(".") + 1),
      type,
      documents: 0,
      bytesRaw: 0,
      files: [],
    })),
  } as unknown as Manifest;
}

describe("read-backup helpers", () => {
  it("accepts <database>.<collection> namespaces only", () => {
    expect(() => assertNamespace("app.users")).not.toThrow();
    for (const bad of ["app", ".users", "app."]) {
      expect(() => assertNamespace(bad, "target")).toThrow(/is not a valid target/);
    }
  });

  it("finds collections and time series, not views or missing namespaces", () => {
    const manifest = manifestWith([
      { ns: "app.users", type: "collection" },
      { ns: "app.recent", type: "view" },
      { ns: "app.metrics", type: "timeseries" },
    ]);
    expect(documentNamespace(manifest, "app.users")?.ns).toBe("app.users");
    expect(documentNamespace(manifest, "app.metrics")?.type).toBe("timeseries");
    expect(documentNamespace(manifest, "app.recent")).toBeUndefined();
    expect(documentNamespace(manifest, "app.missing")).toBeUndefined();
  });

  it("refuses catalog entries without a manifest and damaged documents", () => {
    expect(() =>
      manifestOf({
        id: "2026-01-01T00-00-00Z_abcdef",
        startedAt: new Date(),
        status: "incomplete",
      }),
    ).toThrow(/has no manifest/);
    expect(() => parseRawDocument(Buffer.from([1, 2, 3]))).toThrow(/not valid BSON/);
  });
});
