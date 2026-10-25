/** Tests for the CRDs: structural schemas, examples, generated YAML in sync. */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";
import { makeBackup, makePlan, makeRestore } from "../../test/helpers/fixtures.ts";
import { validateAgainst } from "../../test/helpers/schema-validator.ts";
import { API_GROUP, API_VERSION } from "./constants.ts";
import {
  ALL_CRDS,
  backupCrd,
  backupPlanCrd,
  drillCrd,
  type JsonSchema,
  restoreCrd,
} from "./crds.ts";
import { renderCrdsYaml } from "./crds-yaml.ts";

function rootSchema(crd: (typeof ALL_CRDS)[number]): JsonSchema {
  const version = crd.spec.versions[0];
  if (!version) throw new Error("no version");
  return version.schema.openAPIV3Schema;
}

/** Every node of a schema, with its path. */
function* walk(schema: JsonSchema, path = "$"): Generator<[string, JsonSchema]> {
  yield [path, schema];
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    yield* walk(child, `${path}.${key}`);
  if (schema.items) yield* walk(schema.items, `${path}[]`);
  if (schema.additionalProperties) yield* walk(schema.additionalProperties, `${path}{}`);
}

describe("CRDs", () => {
  it("are namespaced, in mongoshield.io/v1alpha1, with a status subresource", () => {
    for (const crd of ALL_CRDS) {
      expect(crd.metadata.name).toBe(`${crd.spec.names.plural}.${API_GROUP}`);
      expect(crd.spec.scope).toBe("Namespaced");
      expect(crd.spec.versions).toHaveLength(1);
      expect(crd.spec.versions[0]).toMatchObject({
        name: API_VERSION,
        served: true,
        storage: true,
        subresources: { status: {} },
      });
      expect(crd.spec.names.categories).toEqual(["mongoshield"]);
    }
  });

  it("have structural schemas: every field has a type, every string and list a bound", () => {
    for (const crd of ALL_CRDS) {
      for (const [path, node] of walk(rootSchema(crd))) {
        const free = node["x-kubernetes-int-or-string"] === true;
        if (!free) expect(node.type, `${crd.spec.names.kind} ${path}`).toBeDefined();
        if (node.type === "string" && !path.endsWith(".apiVersion") && !path.endsWith(".kind")) {
          const bounded = node.maxLength !== undefined || node.enum !== undefined;
          expect(bounded, `${crd.spec.names.kind} ${path} needs maxLength`).toBe(true);
        }
        if (node.type === "array")
          expect(node.maxItems, `${crd.spec.names.kind} ${path}`).toBeDefined();
      }
    }
  });

  it("accept the example objects used throughout the tests and docs", () => {
    const plan = makePlan("nightly", {
      encryption: {
        recipients: ["age1example"],
        identitySecretRef: { name: "age-key", key: "key.txt" },
      },
      backup: {
        include: ["app.*"],
        exclude: ["*.sessions"],
        consistency: "snapshot",
        compression: "zstd",
        labels: { env: "prod" },
      },
      storage: { url: "/backups", persistentVolumeClaim: { claimName: "backups" } },
      verify: "deep",
      incremental: { fullEveryDays: 7, maxChainLength: 24 },
      job: {
        resources: { requests: { cpu: "250m", memory: 268435456 as unknown as string } },
        backoffLimit: 0,
      },
      extraConfig: { notify: [{ type: "slack", url: "https://hooks.slack.com/x" }] },
    });
    expect(validateAgainst(rootSchema(backupPlanCrd), plan)).toEqual([]);
    expect(
      validateAgainst(rootSchema(backupCrd), makeBackup("b", "nightly", { verify: "fast" })),
    ).toEqual([]);
    expect(
      validateAgainst(
        rootSchema(restoreCrd),
        makeRestore("r", {
          mode: "drop",
          confirm: "staging-mongodb",
          rename: [{ from: "a.*", to: "b.*" }],
        }),
      ),
    ).toEqual([]);
  });

  it("accept every example in deploy/operator/examples", () => {
    const directory = resolve(import.meta.dirname, "../../../../deploy/operator/examples");
    const schemas: Record<string, JsonSchema> = {
      MongoShieldBackupPlan: rootSchema(backupPlanCrd),
      MongoShieldBackup: rootSchema(backupCrd),
      MongoShieldRestore: rootSchema(restoreCrd),
      MongoShieldDrill: rootSchema(drillCrd),
    };
    let checked = 0;
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".yaml"))) {
      for (const document of loadAll(readFileSync(resolve(directory, file), "utf8")) as {
        kind: string;
      }[]) {
        const schema = schemas[document.kind];
        expect(schema, `${file}: unknown kind ${document.kind}`).toBeDefined();
        if (schema) expect(validateAgainst(schema, document), file).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("refuse objects with mistakes", () => {
    const badPlan = {
      ...makePlan(),
      spec: { ...makePlan().spec, storage: { url: "relative/path" }, verify: "sometimes", typo: 1 },
    };
    const problems = validateAgainst(rootSchema(backupPlanCrd), badPlan);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(".spec.storage.url: does not match"),
        expect.stringContaining(".spec.verify"),
        ".spec.typo: unknown field",
      ]),
    );
    expect(validateAgainst(rootSchema(backupCrd), { ...makeBackup(), spec: {} })).toEqual([
      ".spec.planRef: required",
    ]);
    expect(
      validateAgainst(rootSchema(restoreCrd), {
        ...makeRestore(),
        spec: { planRef: { name: "p" } },
      }),
    ).toEqual([".spec.target: required"]);
  });

  it("carry the safety rules as CEL validations", () => {
    const restoreSpec = rootSchema(restoreCrd).properties?.spec;
    const rules = restoreSpec?.["x-kubernetes-validations"]?.map((rule) => rule.rule) ?? [];
    expect(rules).toContain("self == oldSelf");
    expect(
      rules.some((rule) => rule.includes("self.confirm == self.target.uriSecretRef.name")),
    ).toBe(true);
    // A backup's run settings are immutable one by one; its deletionPolicy may change.
    const backupSpec = rootSchema(backupCrd).properties?.spec?.properties ?? {};
    for (const field of ["planRef", "verify", "prune"]) {
      expect(backupSpec[field]?.["x-kubernetes-validations"]?.[0]?.rule, field).toBe(
        "self == oldSelf",
      );
    }
    expect(backupSpec.deletionPolicy).toMatchObject({
      enum: ["Retain", "Delete"],
      default: "Retain",
    });
    expect(backupSpec.deletionPolicy?.["x-kubernetes-validations"]).toBeUndefined();
    // verify: drill needs a scratch deployment; drills are immutable.
    const planRules =
      rootSchema(backupPlanCrd).properties?.spec?.["x-kubernetes-validations"] ?? [];
    expect(planRules.map((rule) => rule.rule)).toEqual([
      "!has(self.verify) || self.verify != 'drill' || has(self.drill)",
    ]);
    const drillRules = rootSchema(drillCrd).properties?.spec?.["x-kubernetes-validations"] ?? [];
    expect(drillRules.map((rule) => rule.rule)).toEqual(["self == oldSelf"]);
  });

  it("survive the YAML round trip unchanged (no field dropped, e.g. CEL rules or enums)", () => {
    const parsed = loadAll(renderCrdsYaml());
    expect(parsed).toEqual(ALL_CRDS);
    expect(renderCrdsYaml()).toContain("x-kubernetes-validations");
  });

  it("are in sync with the generated YAML in deploy/ (run `pnpm --filter @mongoshield/operator crds`)", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const expected = renderCrdsYaml();
    for (const file of [
      "deploy/helm/mongoshield-operator/crds/mongoshield.io_crds.yaml",
      "deploy/operator/crds.yaml",
    ]) {
      expect(readFileSync(resolve(root, file), "utf8"), file).toBe(expected);
    }
  });
});
