// Unit tests for the Queryable Encryption checks of a backup (backup-qe.ts): which
// namespaces are a QE collection's state collections, and when a selection leaves them
// out. A real backup and restore of a QE collection is in
// test/integration/queryable-encryption.test.ts.

import { describe, expect, it } from "vitest";
import type { CollectionSpec } from "../mongo/index.ts";
import { queryableEncryptionWarnings, stateCollectionsOf } from "./backup-qe.ts";

/** A collection spec in database `app` with the given listCollections options. */
function spec(name: string, options: CollectionSpec["options"] = {}): CollectionSpec {
  return {
    ns: `app.${name}`,
    db: "app",
    name,
    type: "collection",
    options,
    indexes: [],
    estimatedDocuments: 0,
  };
}

const patients = spec("patients", {
  encryptedFields: {
    escCollection: "enxcol_.patients.esc",
    ecocCollection: "enxcol_.patients.ecoc",
    fields: [{ path: "ssn", bsonType: "string" }],
  },
});

describe("stateCollectionsOf", () => {
  it("names the state collections encryptedFields records, or the server's defaults", () => {
    expect(stateCollectionsOf(patients)).toEqual([
      "app.enxcol_.patients.esc",
      "app.enxcol_.patients.ecoc",
    ]);
    expect(stateCollectionsOf(spec("bare", { encryptedFields: { fields: [] } }))).toEqual([
      "app.enxcol_.bare.esc",
      "app.enxcol_.bare.ecoc",
    ]);
    // The 6.x preview's third collection, when recorded.
    expect(
      stateCollectionsOf(spec("old", { encryptedFields: { eccCollection: "enxcol_.old.ecc" } })),
    ).toContain("app.enxcol_.old.ecc");
    expect(stateCollectionsOf(spec("plain"))).toEqual([]);
  });
});

describe("queryableEncryptionWarnings", () => {
  it("is quiet when every state collection is backed up too", () => {
    expect(
      queryableEncryptionWarnings([
        patients,
        spec("enxcol_.patients.esc"),
        spec("enxcol_.patients.ecoc"),
        spec("plain"),
      ]),
    ).toEqual([]);
  });

  it("warns, naming what is missing, when the selection leaves state collections out", () => {
    const [warning, ...rest] = queryableEncryptionWarnings([
      patients,
      spec("enxcol_.patients.esc"),
    ]);
    expect(rest).toEqual([]);
    expect(warning).toContain("app.patients uses Queryable Encryption");
    expect(warning).toContain("app.enxcol_.patients.ecoc");
    expect(warning).not.toContain("app.enxcol_.patients.esc,");
    expect(warning).toContain("app.enxcol_.patients.*");
  });
});
