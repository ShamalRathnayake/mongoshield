// The upgrade compatibility rules, one by one: each fires on the definition it is
// about, stays quiet on a clean one, and applies only to the versions it should.
// Values are BSON values, as the metadata parser returns them.

import { BSON, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { parseCollectionMetadata, serializeCollectionMetadata } from "../format/metadata.ts";
import {
  analyzeUpgradeCompatibility,
  type BackedUpCollection,
  COMPATIBILITY_RULES,
  type CompatibilityInput,
  type CompatibilityReport,
  invalidKeyValueReason,
  ruleApplies,
} from "./upgrade-compat.ts";
import { parseServerVersion } from "./upgrade-versions.ts";

const { Code, Double, Int32 } = BSON;

/** A collection (or view, or time series) with the given options and indexes. */
function collection(
  ns: string,
  options: Document = {},
  indexes: Document[] = [],
  type: BackedUpCollection["type"] = "collection",
): BackedUpCollection {
  return {
    ns,
    type,
    metadata: { collectionName: ns.slice(ns.indexOf(".") + 1), type, options, indexes },
  };
}

/** A view on `viewOn` with the given pipeline. */
function view(ns: string, pipeline: unknown[], viewOn = "items"): BackedUpCollection {
  return collection(ns, { viewOn, pipeline }, [], "view");
}

/** A collection with one index besides `_id_`. */
function indexed(index: Document, ns = "app.items"): BackedUpCollection {
  return collection(ns, {}, [{ v: new Int32(2), key: { _id: new Int32(1) }, name: "_id_" }, index]);
}

/** Runs the analysis; 7.0 → 8.0 unless said otherwise. */
function analyze(input: Partial<CompatibilityInput>): CompatibilityReport {
  return analyzeUpgradeCompatibility({
    sourceVersion: "7.0.32",
    targetVersion: "8.0",
    collections: [],
    ...input,
  });
}

/** The findings of one rule. */
function findings(report: CompatibilityReport, rule: string) {
  return report.findings.filter((finding) => finding.rule === rule);
}

/** The single finding of one rule (fails the test when there is not exactly one). */
function only(report: CompatibilityReport, rule: string) {
  const found = findings(report, rule);
  expect(found).toHaveLength(1);
  return found[0] as (typeof found)[number];
}

describe("a clean backup", () => {
  it("has no findings and passes", () => {
    const report = analyze({
      collections: [
        indexed({ v: new Int32(2), key: { label: new Int32(1) }, name: "by_label", unique: true }),
        collection("app.audit", { validator: { $jsonSchema: { required: ["at"] } } }),
        view("app.recent", [{ $sort: { at: new Int32(-1) } }, { $limit: new Int32(5) }]),
      ],
      users: [
        { user: "app", db: "admin", credentials: { "SCRAM-SHA-256": {}, "SCRAM-SHA-1": {} } },
      ],
      roles: [{ role: "reader", db: "app" }],
    });
    expect(report).toMatchObject({
      ok: true,
      findings: [],
      sourceVersion: "7.0.32",
      targetVersion: "8.0",
      upgradePath: ["8.0"],
    });
    expect(report.rulesChecked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

describe("index rules", () => {
  it("index-geohaystack: a geoHaystack index is a problem from 5.0 on", () => {
    const geo = indexed({
      v: new Int32(1),
      key: { loc: "geoHaystack", type: new Int32(1) },
      name: "geo",
      bucketSize: new Int32(1),
    });
    const finding = only(
      analyze({ sourceVersion: "4.4.29", targetVersion: "5.0", collections: [geo] }),
      "index-geohaystack",
    );
    expect(finding).toMatchObject({ severity: "problem", subject: "app.items", since: "5.0" });
    expect(finding.message).toContain('"geo"');
    expect(finding.message).toContain("2d index");
    // Not a known problem before 5.0 (and not "an unknown index type" for the key rule).
    const old = analyze({ sourceVersion: "4.2.0", targetVersion: "4.4", collections: [geo] });
    expect(findings(old, "index-geohaystack")).toEqual([]);
    expect(findings(old, "index-invalid-key")).toEqual([]);
  });

  it("index-ttl-nan: expireAfterSeconds NaN would expire documents at once", () => {
    const nan = indexed({
      key: { at: new Int32(1) },
      name: "ttl",
      expireAfterSeconds: new Double(Number.NaN),
    });
    expect(only(analyze({ collections: [nan] }), "index-ttl-nan").message).toContain(
      "expire immediately",
    );
    const real = indexed({
      key: { at: new Int32(1) },
      name: "ttl",
      expireAfterSeconds: new Int32(3600),
    });
    expect(findings(analyze({ collections: [real] }), "index-ttl-nan")).toEqual([]);
  });

  it("index-weights-without-text: weights on a non-text index", () => {
    const bad = indexed({ key: { a: new Int32(1) }, name: "a", weights: { a: new Int32(2) } });
    expect(only(analyze({ collections: [bad] }), "index-weights-without-text").severity).toBe(
      "problem",
    );
    const text = indexed({
      key: { _fts: "text", _ftsx: new Int32(1) },
      name: "t",
      weights: { body: new Int32(2) },
    });
    expect(findings(analyze({ collections: [text] }), "index-weights-without-text")).toEqual([]);
  });

  it("index-invalid-key: legacy key values the server refuses", () => {
    for (const [value, expected] of [
      [new Int32(0), "0"],
      [new Double(Number.NaN), "NaN"],
      ["", "an empty string"],
      ["1", '"1" (not an index type)'],
      [true, "a value of type boolean"],
      [null, "a value of type null"],
      [new BSON.ObjectId(), "a value of type ObjectId"],
    ] as const) {
      const report = analyze({ collections: [indexed({ key: { a: value }, name: "a_legacy" })] });
      expect(only(report, "index-invalid-key").message).toContain(
        `has ${expected} as the key value of "a"`,
      );
    }
  });

  it("index-invalid-key: accepts numbers, index types and wildcards", () => {
    const keys = [
      { a: new Int32(1) },
      { a: new Double(-0.5) },
      { a: BSON.Long.fromNumber(1) },
      { a: "hashed" },
      { loc: "2dsphere" },
      { loc: "2d" },
      { "$**": new Int32(1) },
      { _fts: "text", _ftsx: new Int32(1) },
    ];
    for (const key of keys) {
      expect(
        findings(analyze({ collections: [indexed({ key, name: "k" })] }), "index-invalid-key"),
      ).toEqual([]);
    }
    expect(invalidKeyValueReason("columnstore")).toBeUndefined();
  });

  it("index-unknown-option: fields createIndexes does not accept", () => {
    const report = analyze({
      collections: [indexed({ key: { a: new Int32(1) }, name: "a", safe: true, w: new Int32(1) })],
    });
    expect(only(report, "index-unknown-option").message).toContain('options "safe", "w"');
    const single = analyze({
      collections: [indexed({ key: { a: new Int32(1) }, name: "a", safe: true })],
    });
    expect(only(single, "index-unknown-option").message).toContain('option "safe" that');
    // Legacy fields the server still accepts (or restore strips) are fine.
    const accepted = indexed({
      v: new Int32(2),
      key: { a: new Int32(1) },
      name: "a",
      ns: "app.items",
      background: true,
      dropDups: true,
      sparse: true,
      hidden: false,
    });
    expect(findings(analyze({ collections: [accepted] }), "index-unknown-option")).toEqual([]);
  });

  it("index-version-legacy: v0 and v1 indexes are a warning, once per collection", () => {
    const report = analyze({
      collections: [
        collection("app.old", {}, [
          { v: new Int32(1), key: { _id: new Int32(1) }, name: "_id_" },
          { v: new Int32(0), key: { a: new Int32(1) }, name: "a" },
          { v: new Int32(2), key: { b: new Int32(1) }, name: "b" },
        ]),
        collection("app.one", {}, [{ v: new Int32(1), key: { c: new Int32(1) }, name: "c" }]),
      ],
    });
    const [old, one] = findings(report, "index-version-legacy");
    expect(old).toMatchObject({ severity: "warning", subject: "app.old" });
    expect(old?.message).toContain('"_id_" (v1), "a" (v0) use an old index format');
    expect(one?.message).toContain('"c" (v1) uses an old index format');
    expect(report.ok).toBe(true);
  });

  it("names unnamed indexes in messages", () => {
    const report = analyze({ collections: [indexed({ key: { a: new Int32(0) } })] });
    expect(only(report, "index-invalid-key").message).toContain('"(unnamed)"');
  });
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

describe("collection rules", () => {
  it("collection-unknown-option: options create does not accept (except those restore strips)", () => {
    const report = analyze({
      collections: [
        collection("app.a", { usePowerOf2Sizes: true }),
        collection("app.b", { usePowerOf2Sizes: true, noPadding: false }),
        collection("app.c", {
          flags: new Int32(1),
          autoIndexId: true,
          recordPreImages: false,
          capped: true,
          size: new Int32(4096),
        }),
      ],
    });
    const found = findings(report, "collection-unknown-option");
    expect(found.map((finding) => finding.subject)).toEqual(["app.a", "app.b"]);
    expect(found[0]?.message).toContain('option "usePowerOf2Sizes" is not accepted');
    expect(found[1]?.message).toContain('options "usePowerOf2Sizes", "noPadding" are not accepted');
  });

  it("collection-no-id-index: autoIndexId false gets an _id index on restore", () => {
    const report = analyze({ collections: [collection("app.log", { autoIndexId: false })] });
    expect(only(report, "collection-no-id-index")).toMatchObject({
      severity: "warning",
      since: "4.0",
    });
  });

  it("encryption-preview: Queryable Encryption from 6.x does not carry over to 7.0", () => {
    const encrypted = collection("app.patients", {
      encryptedFields: { fields: [{ path: "ssn", bsonType: "string" }] },
    });
    expect(
      only(
        analyze({ sourceVersion: "6.0.20", targetVersion: "7.0", collections: [encrypted] }),
        "encryption-preview",
      ).severity,
    ).toBe("problem");
    // Already on 7.0: the GA format, nothing to do. Unknown source: flagged to be safe.
    expect(
      findings(analyze({ sourceVersion: "7.0.2", collections: [encrypted] }), "encryption-preview"),
    ).toEqual([]);
    expect(
      findings(
        analyze({ sourceVersion: "unknown", collections: [encrypted] }),
        "encryption-preview",
      ),
    ).toHaveLength(1);
    // A crossing rule: 6.0 → 6.3 does not cross 7.0.
    expect(
      findings(
        analyze({ sourceVersion: "6.0.20", targetVersion: "6.3", collections: [encrypted] }),
        "encryption-preview",
      ),
    ).toEqual([]);
  });

  it("encryption-range-preview: the rangePreview algorithm is gone in 8.0", () => {
    const report = analyze({
      collections: [
        collection("app.pay", {
          encryptedFields: {
            fields: [
              { path: "amount", queries: { queryType: "rangePreview" } },
              { path: "due", queries: [{ queryType: "equality" }, { queryType: "rangePreview" }] },
              { path: "ssn", queries: { queryType: "equality" } },
              "not a field",
            ],
          },
        }),
        collection("app.ok", {
          encryptedFields: { fields: [{ path: "x", queries: [{ queryType: "range" }] }] },
        }),
        collection("app.weird", { encryptedFields: { fields: "none" } }),
      ],
    });
    expect(only(report, "encryption-range-preview").message).toContain(
      '"amount", "due" use the rangePreview',
    );
    const single = analyze({
      collections: [
        collection("app.p", {
          encryptedFields: { fields: [{ path: "a", queries: { queryType: "rangePreview" } }] },
        }),
      ],
    });
    expect(only(single, "encryption-range-preview").message).toContain('field "a" uses');
  });
});

// ---------------------------------------------------------------------------
// Views and validators
// ---------------------------------------------------------------------------

describe("view and validator rules", () => {
  it("view-pipeline-too-long: more than 1000 stages", () => {
    const long = view(
      "app.long",
      Array.from({ length: 1001 }, () => ({ $match: {} })),
    );
    expect(only(analyze({ collections: [long] }), "view-pipeline-too-long").message).toContain(
      "1001 stages",
    );
    const fine = view(
      "app.fine",
      Array.from({ length: 1000 }, () => ({ $match: {} })),
    );
    expect(findings(analyze({ collections: [fine] }), "view-pipeline-too-long")).toEqual([]);
    // A view whose pipeline is missing counts as empty.
    expect(
      findings(
        analyze({ collections: [collection("app.v", { viewOn: "x" }, [], "view")] }),
        "view-pipeline-too-long",
      ),
    ).toEqual([]);
  });

  it("view-on-buckets: views reading a system.buckets collection", () => {
    const report = analyze({
      collections: [view("app.raw", [], "system.buckets.metrics"), view("app.fine", [], "metrics")],
    });
    expect(only(report, "view-on-buckets")).toMatchObject({
      severity: "warning",
      subject: "app.raw",
    });
  });

  it("regex-invalid-options: in validators (blocks writes) and in views", () => {
    const report = analyze({
      collections: [
        collection("app.a", { validator: { name: { $regex: "^a", $options: "iq" } } }),
        view("app.v", [{ $match: { name: new BSON.BSONRegExp("^b", "l") } }]),
        collection("app.ok", { validator: { name: new BSON.BSONRegExp("^c", "imxsu") } }),
      ],
    });
    const [validator, pipeline] = findings(report, "regex-invalid-options");
    expect(validator?.message).toContain('option "q"');
    expect(validator?.message).toContain("blocks every insert and update");
    expect(pipeline?.message).toContain('option "l",');
    expect(pipeline?.message).toContain("when the view is queried");
    expect(findings(report, "regex-invalid-options")).toHaveLength(2);
  });

  it("javascript-removed-functions: removed static functions in view JavaScript", () => {
    const report = analyze({
      sourceVersion: "5.0.30",
      targetVersion: "6.0",
      collections: [
        view("app.js", [
          {
            $addFields: {
              n: {
                $function: {
                  body: new Code("function(a){ return Array.concat([a],[1]).length }"),
                  args: ["$a"],
                  lang: "js",
                },
              },
            },
          },
        ]),
        view("app.modern", [
          {
            $addFields: {
              n: {
                $function: {
                  body: "function(a){ return [a].concat([1]).length }",
                  args: [],
                  lang: "js",
                },
              },
            },
          },
        ]),
      ],
    });
    const finding = only(report, "javascript-removed-functions");
    expect(finding).toMatchObject({ subject: "app.js", severity: "problem" });
    expect(finding.message).toContain("Array.concat");
  });

  it("javascript-deprecated: server-side JavaScript is deprecated in 8.0", () => {
    const js = view("app.js", [
      {
        $match: { $expr: { $function: { body: "function(){return true}", args: [], lang: "js" } } },
      },
    ]);
    expect(only(analyze({ collections: [js] }), "javascript-deprecated").message).toContain(
      "$function",
    );
    expect(
      findings(
        analyze({ sourceVersion: "6.0.1", targetVersion: "7.0", collections: [js] }),
        "javascript-deprecated",
      ),
    ).toEqual([]);
  });

  it("rank-null-missing: $rank and $denseRank only when crossing 8.0", () => {
    const ranked = view("app.ranked", [
      {
        $setWindowFields: {
          sortBy: { score: new Int32(-1) },
          output: { r: { $rank: {} }, d: { $denseRank: {} } },
        },
      },
    ]);
    expect(only(analyze({ collections: [ranked] }), "rank-null-missing").message).toContain(
      "$denseRank and $rank",
    );
    expect(
      findings(
        analyze({ sourceVersion: "8.0.4", targetVersion: "8.2", collections: [ranked] }),
        "rank-null-missing",
      ),
    ).toEqual([]);
    expect(
      findings(
        analyze({ collections: [view("app.plain", [{ $limit: new Int32(1) }])] }),
        "rank-null-missing",
      ),
    ).toEqual([]);
  });

  it("add-floating-point: $add in views and validators when crossing 6.1", () => {
    const report = analyze({
      sourceVersion: "6.0.20",
      targetVersion: "7.0",
      collections: [
        view("app.sum", [{ $project: { total: { $add: ["$a", "$b"] } } }]),
        collection("app.check", {
          validator: { $expr: { $lt: [{ $add: ["$a", "$b"] }, new Int32(10)] } },
        }),
      ],
    });
    expect(findings(report, "add-floating-point").map((finding) => finding.subject)).toEqual([
      "app.sum",
      "app.check",
    ]);
    expect(
      findings(
        analyze({
          sourceVersion: "7.0.2",
          collections: [view("app.sum", [{ $project: { t: { $add: [1, 2] } } }])],
        }),
        "add-floating-point",
      ),
    ).toEqual([]);
  });

  it("null-matches-undefined: validators and views comparing with null, when crossing 8.0", () => {
    const report = analyze({
      collections: [
        collection("app.users", {
          validator: { $or: [{ deletedAt: null }, { deletedAt: { $type: "date" } }] },
        }),
        view("app.active", [{ $match: { archivedAt: { $eq: null } } }]),
        view("app.joined", [
          { $lookup: { from: "orders", localField: "a", foreignField: "b", as: "o" } },
        ]),
        view("app.both", [
          { $match: { x: null } },
          { $lookup: { from: "orders", localField: "a", foreignField: "b", as: "o" } },
        ]),
        view("app.none", [{ $match: { x: new Int32(1) } }]),
      ],
    });
    const found = findings(report, "null-matches-undefined");
    expect(found.map((finding) => finding.subject)).toEqual([
      "app.users",
      "app.active",
      "app.joined",
      "app.both",
    ]);
    expect(found[0]?.message).toContain('validator compares "deletedAt" with null');
    expect(found[0]?.message).toContain("live rehearsal counts");
    expect(found[1]?.message).toContain('view compares "archivedAt" with null');
    expect(found[2]?.message).toContain("view joins with $lookup");
    expect(found[3]?.message).toContain('compares "x" with null and joins with $lookup');
    // Already on 8.0: nothing changes.
    const onEight = analyze({
      sourceVersion: "8.0.1",
      collections: [collection("app.u", { validator: { a: null } })],
    });
    expect(findings(onEight, "null-matches-undefined")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stored JavaScript, users and roles
// ---------------------------------------------------------------------------

describe("stored JavaScript, user and role rules", () => {
  it("javascript-stored-removed-functions: system.js functions calling removed functions", () => {
    const report = analyze({
      storedJavaScript: [
        {
          ns: "app.system.js",
          documents: [
            { _id: "joinAll", value: new Code("function(a){ return Array.join(a, ',') }") },
            { _id: "fine", value: new Code("function(a){ return a.join(',') }") },
            { _id: "notCode", value: new Int32(5) },
          ],
        },
        {
          ns: "other.system.js",
          documents: [
            { _id: "x", value: "function(){ return String.trim(' a ') }" },
            { _id: "y", value: "String.split(s)" },
          ],
        },
        { ns: "clean.system.js", documents: [] },
      ],
    });
    const [app, other] = findings(report, "javascript-stored-removed-functions");
    expect(app).toMatchObject({ subject: "app.system.js", severity: "warning" });
    expect(app?.message).toContain("stored function joinAll calls");
    expect(other?.message).toContain("stored functions x, y call");
  });

  it("user-mongodb-cr: users without SCRAM credentials", () => {
    const report = analyze({
      users: [
        { user: "legacy", db: "app", credentials: { "MONGODB-CR": "hash" } },
        { user: "fine", db: "app", credentials: { "MONGODB-CR": "hash", "SCRAM-SHA-1": {} } },
        { user: "x509", db: "$external", roles: [] },
      ],
    });
    expect(only(report, "user-mongodb-cr").message).toContain("legacy@app only has MONGODB-CR");
    const two = analyze({
      users: [1, 2].map((n) => ({ user: `u${n}`, db: "a", credentials: { "MONGODB-CR": "h" } })),
    });
    expect(only(two, "user-mongodb-cr").message).toContain("u1@a, u2@a only have");
  });

  it("user-scram-sha1-only: a FIPS-mode warning, listing at most ten names", () => {
    const users = Array.from({ length: 12 }, (_, n) => ({
      user: `u${n}`,
      db: "app",
      credentials: { "SCRAM-SHA-1": {} },
    }));
    const finding = only(analyze({ users }), "user-scram-sha1-only");
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("u9@app and 2 more only have SCRAM-SHA-1");
    expect(only(analyze({ users: users.slice(0, 1) }), "user-scram-sha1-only").message).toContain(
      "u0@app only has",
    );
  });

  it("role-ldap-mapping: roles named like LDAP distinguished names", () => {
    const report = analyze({
      roles: [
        { role: "cn=dba,ou=groups,dc=example,dc=com", db: "admin" },
        { role: "reporting", db: "admin" },
        { role: 42, db: "admin" },
      ],
    });
    expect(only(report, "role-ldap-mapping").message).toContain(
      "cn=dba,ou=groups,dc=example,dc=com@admin looks like",
    );
    const two = analyze({
      roles: [
        { role: "CN=a", db: "admin" },
        { role: "ou=b,dc=c", db: "admin" },
      ],
    });
    expect(only(two, "role-ldap-mapping").message).toContain("look like LDAP");
  });
});

// ---------------------------------------------------------------------------
// Versions and the upgrade path
// ---------------------------------------------------------------------------

describe("upgrade path findings", () => {
  it("upgrade-downgrade: a target older than the source is a problem", () => {
    const report = analyze({ sourceVersion: "8.0.13", targetVersion: "7.0" });
    expect(only(report, "upgrade-downgrade").severity).toBe("problem");
    expect(report).toMatchObject({ ok: false, upgradePath: [] });
  });

  it("upgrade-same-release: the same series is at most a patch upgrade", () => {
    expect(
      only(analyze({ sourceVersion: "8.0.4", targetVersion: "8.0.13" }), "upgrade-same-release")
        .severity,
    ).toBe("warning");
  });

  it("upgrade-multiple-steps: names every step production must take", () => {
    const report = analyze({ sourceVersion: "5.0.30", targetVersion: "8.0.13" });
    expect(only(report, "upgrade-multiple-steps").message).toContain("5.0 → 6.0 → 7.0 → 8.0");
    expect(report.upgradePath).toEqual(["6.0", "7.0", "8.0"]);
    expect(findings(analyze({}), "upgrade-multiple-steps")).toEqual([]);
  });

  it("upgrade-target-unknown: targets newer than the encoded notes", () => {
    expect(only(analyze({ targetVersion: "9.0" }), "upgrade-target-unknown").message).toContain(
      "up to 8.0",
    );
    expect(only(analyze({ targetVersion: "8.2" }), "upgrade-target-unknown")).toBeDefined();
    expect(findings(analyze({ targetVersion: "8.0.13" }), "upgrade-target-unknown")).toEqual([]);
  });

  it("upgrade-source-unknown: imported dumps without a version get every rule", () => {
    const ranked = view("app.ranked", [{ $setWindowFields: { output: { r: { $rank: {} } } } }]);
    const report = analyze({ sourceVersion: "unknown", collections: [ranked] });
    expect(only(report, "upgrade-source-unknown").severity).toBe("warning");
    expect(findings(report, "rank-null-missing")).toHaveLength(1);
    expect(report.upgradePath).toEqual([]);
  });

  it("metadata-unreadable: reported as warnings, not silently skipped", () => {
    const report = analyze({ unreadable: [{ ns: "app.broken", reason: "checksum mismatch" }] });
    expect(only(report, "metadata-unreadable")).toMatchObject({
      subject: "app.broken",
      severity: "warning",
    });
  });

  it("rejects a target that is not a version", () => {
    expect(() => analyze({ targetVersion: "latest" })).toThrow(/not a MongoDB version/);
  });
});

describe("the analysis as a whole", () => {
  it("lists problems before warnings and fails on any problem", () => {
    const report = analyze({
      collections: [
        view("app.ranked", [{ $setWindowFields: { output: { r: { $rank: {} } } } }]),
        indexed({ key: { a: new Int32(0) }, name: "zero" }),
      ],
    });
    expect(report.findings.map((finding) => finding.severity)).toEqual(["problem", "warning"]);
    expect(report.ok).toBe(false);
  });

  it("counts only the rules that apply to the versions", () => {
    const to50 = analyze({ sourceVersion: "4.4.29", targetVersion: "5.0" }).rulesChecked;
    const to80 = analyze({ sourceVersion: "4.4.29", targetVersion: "8.0" }).rulesChecked;
    expect(to80).toBeGreaterThan(to50);
    expect(to80).toBeLessThanOrEqual(COMPATIBILITY_RULES.length);
  });

  it("works on metadata exactly as stored (canonical Extended JSON round trip)", () => {
    const stored = serializeCollectionMetadata({
      collectionName: "items",
      type: "collection",
      options: { validator: { deletedAt: null } },
      indexes: [
        {
          v: new Int32(1),
          key: { a: new Double(Number.NaN) },
          name: "nan",
          expireAfterSeconds: new Double(Number.NaN),
        },
      ],
    });
    const metadata = parseCollectionMetadata(stored);
    const report = analyze({ collections: [{ ns: "app.items", type: "collection", metadata }] });
    expect(report.findings.map((finding) => finding.rule).sort()).toEqual(
      [
        "index-invalid-key",
        "index-ttl-nan",
        "index-version-legacy",
        "null-matches-undefined",
      ].sort(),
    );
  });

  it("every rule has an id, a source and a summary, and ids are unique", () => {
    const ids = COMPATIBILITY_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of COMPATIBILITY_RULES) {
      expect(rule.reference).toMatch(/^https:\/\//);
      expect(rule.summary.length).toBeGreaterThan(10);
      expect(parseServerVersion(rule.since)).toBeDefined();
    }
  });
});

describe("ruleApplies", () => {
  const target = { since: "8.0", applies: "target" } as const;
  const crossing = { since: "8.0", applies: "crossing" } as const;
  const version = (text: string) =>
    parseServerVersion(text) ?? { major: 0, minor: 0, patch: undefined };

  it("target rules apply whenever the target is new enough", () => {
    expect(ruleApplies(target, version("8.0.1"), version("8.0"))).toBe(true);
    expect(ruleApplies(target, version("6.0.1"), version("7.0"))).toBe(false);
  });

  it("crossing rules apply only when the upgrade crosses the release", () => {
    expect(ruleApplies(crossing, version("7.0.1"), version("8.0"))).toBe(true);
    expect(ruleApplies(crossing, version("8.0.1"), version("8.2"))).toBe(false);
    expect(ruleApplies(crossing, undefined, version("8.0"))).toBe(true);
  });
});
