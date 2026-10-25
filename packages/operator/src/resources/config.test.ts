/** Tests for turning a plan into mongoshield.config.json. */

import { describe, expect, it } from "vitest";
import { makePlan } from "../../test/helpers/fixtures.ts";
import { buildMongoShieldConfig, deepMerge, validateMongoShieldConfig } from "./config.ts";

describe("buildMongoShieldConfig", () => {
  it("maps every plan field to the config file, with no secrets in it", () => {
    const config = buildMongoShieldConfig(
      makePlan("nightly", {
        encryption: {
          recipients: ["age1abc"],
          kms: [{ provider: "aws", key: "alias/backups" }],
          identitySecretRef: { name: "age-key" },
        },
        backup: {
          include: ["app.*"],
          exclude: ["*.sessions"],
          consistency: "snapshot",
          compression: "gzip",
          parallelism: 8,
          readPreference: "secondary",
          labels: { env: "prod" },
          retainDays: 30,
          usersAndRoles: true,
        },
        verify: "deep",
        retries: 4,
        lock: "mongo",
      }),
    );
    expect(config).toEqual({
      storage: "s3://acme-backups/prod?region=eu-west-1",
      compression: "gzip",
      encryption: { recipients: ["age1abc"], kms: [{ provider: "aws", key: "alias/backups" }] },
      backup: {
        include: ["app.*"],
        exclude: ["*.sessions"],
        consistency: "snapshot",
        parallelism: 8,
        readPreference: "secondary",
        retainDays: 30,
        usersAndRoles: true,
        labels: { env: "prod" },
      },
      retention: {
        last: 3,
        daily: 7,
        scopeLabels: { "mongoshield.plan": "kubernetes/prod/nightly" },
      },
      schedule: {
        cron: "15 3 * * *",
        timezone: "Etc/UTC",
        lock: "mongo",
        retries: 4,
        verify: "deep",
        prune: true,
      },
    });
    expect(JSON.stringify(config)).not.toContain("prod-mongodb");
    expect(validateMongoShieldConfig(config)).toBeUndefined();
  });

  it("leaves out the schedule section for manual-only plans, and empty retention", () => {
    const { schedule: _schedule, ...spec } = makePlan().spec;
    const config = buildMongoShieldConfig({ ...makePlan(), spec: { ...spec, retention: {} } });
    expect(config).not.toHaveProperty("schedule");
    // Only the scope labels: nothing is pruned, but every backup is marked as the plan's.
    expect(config.retention).toEqual({
      scopeLabels: { "mongoshield.plan": "kubernetes/prod/nightly" },
    });
    expect(config).not.toHaveProperty("encryption");
    expect(config).not.toHaveProperty("drill");
    expect(validateMongoShieldConfig(config)).toBeUndefined();
  });

  it("merges extraConfig underneath, the plan's own fields winning", () => {
    const config = buildMongoShieldConfig(
      makePlan("nightly", {
        extraConfig: {
          storage: "ignored://x",
          heartbeat: "https://hc-ping.com/uuid",
          backup: { maxBytesPerSecond: 1000, labels: { team: "data" } },
        },
      }),
    );
    expect(config.storage).toBe("s3://acme-backups/prod?region=eu-west-1");
    expect(config.heartbeat).toBe("https://hc-ping.com/uuid");
    expect(config.backup).toMatchObject({
      maxBytesPerSecond: 1000,
      labels: { team: "data" },
    });
  });

  it("gives two plans with the same source and selection different retention scopes", () => {
    const one = buildMongoShieldConfig(makePlan("daily"));
    const two = buildMongoShieldConfig(makePlan("monthly"));
    expect(one.retention).toMatchObject({
      scopeLabels: { "mongoshield.plan": "kubernetes/prod/daily" },
    });
    expect(two.retention).toMatchObject({
      scopeLabels: { "mongoshield.plan": "kubernetes/prod/monthly" },
    });
  });

  it("writes the drill section without its target, and validates it with a stand-in", () => {
    const config = buildMongoShieldConfig(
      makePlan("nightly", {
        verify: "drill",
        drill: { targetUriSecretRef: { name: "scratch" }, sample: 10, prefix: "k8sdrill_" },
      }),
    );
    expect(config.drill).toEqual({ sample: 10, prefix: "k8sdrill_" });
    expect(config.schedule).toMatchObject({ verify: "drill" });
    expect(JSON.stringify(config)).not.toContain("scratch");
    expect(validateMongoShieldConfig(config)).toBeUndefined();
    // verify: drill without a drill section is refused by MongoShield's schema.
    expect(
      validateMongoShieldConfig(buildMongoShieldConfig(makePlan("p", { verify: "drill" }))),
    ).toContain("drill");
  });

  it("turns spec.incremental into backup.incremental", () => {
    const config = buildMongoShieldConfig(
      makePlan("nightly", { incremental: { fullEveryDays: 7, maxChainLength: 48 } }),
    );
    expect(config.backup).toMatchObject({ incremental: { fullEveryDays: 7, maxChainLength: 48 } });
  });

  it("reports what MongoShield's schema rejects", () => {
    const problem = validateMongoShieldConfig({ storage: "s3://x", extra: true });
    expect(problem).toContain("configuration is invalid");
    expect(validateMongoShieldConfig({ storage: "s3://x", heartbeat: "not a url" })).toContain(
      "heartbeat",
    );
  });
});

describe("deepMerge", () => {
  it("merges nested objects and replaces arrays and scalars", () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: { e: 1 } })).toEqual({
      a: { b: 1, c: [2] },
      d: { e: 1 },
    });
  });
});
