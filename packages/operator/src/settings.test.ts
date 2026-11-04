/** Tests for reading the operator's settings from the environment. */

import { describe, expect, it } from "vitest";
import { readSettings } from "./settings.ts";
import { OPERATOR_VERSION } from "./version.ts";

const noFile = (): string => {
  throw new Error("ENOENT");
};

describe("readSettings", () => {
  it("has safe defaults", () => {
    const settings = readSettings({ POD_NAME: "op-1" }, noFile);
    expect(settings).toMatchObject({
      watchNamespaces: undefined,
      operatorNamespace: "default",
      identity: "op-1",
      // The release the operator ships with, never a moving `latest`.
      image: `ghcr.io/shamalrathnayake/mongoshield:${OPERATOR_VERSION}`,
      imagePullPolicy: undefined,
      // Only the default image's repository; any service account; no spec.job.envFrom.
      jobPolicy: {
        allowedImages: ["ghcr.io/shamalrathnayake/mongoshield"],
        allowedServiceAccounts: ["*"],
        allowEnvFrom: false,
      },
      metricsToken: undefined,
      leaderElection: true,
      leaseName: "mongoshield-operator",
      httpPort: 8080,
      workers: 2,
      resyncMs: 600_000,
      logLevel: "info",
    });
  });

  it("reads every variable", () => {
    const settings = readSettings(
      {
        WATCH_NAMESPACES: "prod, staging,,",
        POD_NAMESPACE: "ops",
        POD_NAME: "op-2",
        MONGOSHIELD_IMAGE: "registry.local/mongoshield:2.0.0",
        MONGOSHIELD_IMAGE_PULL_POLICY: "Never",
        MONGOSHIELD_ALLOWED_IMAGES: "registry.local/mongoshield, registry.local/team/*",
        MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS: "prod/irsa-backups,staging/*",
        MONGOSHIELD_ALLOW_JOB_ENV_FROM: "true",
        METRICS_TOKEN: "scrape-me",
        LEADER_ELECTION: "false",
        LEADER_ELECTION_LEASE: "custom",
        HTTP_PORT: "9090",
        WORKERS: "4",
        RESYNC_SECONDS: "60",
        LOG_LEVEL: "debug",
      },
      noFile,
    );
    expect(settings).toMatchObject({
      watchNamespaces: ["prod", "staging"],
      operatorNamespace: "ops",
      image: "registry.local/mongoshield:2.0.0",
      imagePullPolicy: "Never",
      jobPolicy: {
        allowedImages: ["registry.local/mongoshield", "registry.local/team/*"],
        allowedServiceAccounts: ["prod/irsa-backups", "staging/*"],
        allowEnvFrom: true,
      },
      metricsToken: "scrape-me",
      leaderElection: false,
      leaseName: "custom",
      httpPort: 9090,
      workers: 4,
      resyncMs: 60_000,
      logLevel: "debug",
    });
  });

  it("takes the namespace from the service account mount", () => {
    expect(readSettings({}, () => "mongoshield-system\n").operatorNamespace).toBe(
      "mongoshield-system",
    );
  });

  it("allows a custom default image's repository when MONGOSHIELD_ALLOWED_IMAGES is unset", () => {
    const settings = readSettings({ MONGOSHIELD_IMAGE: "registry.local:5000/ms:2.0.1" }, noFile);
    expect(settings.jobPolicy.allowedImages).toEqual(["registry.local:5000/ms"]);
  });

  it("rejects invalid values with the variable's name", () => {
    expect(() =>
      readSettings({ MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS: "just-a-name" }, noFile),
    ).toThrow("MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS");
    expect(() => readSettings({ MONGOSHIELD_ALLOW_JOB_ENV_FROM: "yes" }, noFile)).toThrow(
      "MONGOSHIELD_ALLOW_JOB_ENV_FROM",
    );
    expect(() => readSettings({ HTTP_PORT: "eighty" }, noFile)).toThrow("HTTP_PORT");
    expect(() => readSettings({ WORKERS: "0" }, noFile)).toThrow("WORKERS");
    expect(() => readSettings({ LOG_LEVEL: "loud" }, noFile)).toThrow("LOG_LEVEL");
    expect(() => readSettings({ MONGOSHIELD_IMAGE_PULL_POLICY: "Sometimes" }, noFile)).toThrow(
      "PULL_POLICY",
    );
  });
});
