/** Tests for the admin's limits on what plans may put into Job pods. */

import { describe, expect, it } from "vitest";
import { makePlan } from "../../test/helpers/fixtures.ts";
import {
  defaultJobPolicy,
  imageRepository,
  imagesRestricted,
  jobPolicyProblem,
  restrictedEnvironment,
} from "./job-policy.ts";

const DEFAULT_IMAGE = "ghcr.io/shamalrathnayake/mongoshield:2.0.1";

describe("imageRepository", () => {
  it("drops the tag and the digest, but keeps a registry port", () => {
    expect(imageRepository("ghcr.io/acme/mongoshield:2.0.1")).toBe("ghcr.io/acme/mongoshield");
    expect(imageRepository("ghcr.io/acme/mongoshield@sha256:abc")).toBe("ghcr.io/acme/mongoshield");
    expect(imageRepository("ghcr.io/acme/ms:2@sha256:abc")).toBe("ghcr.io/acme/ms");
    expect(imageRepository("registry:5000/ms")).toBe("registry:5000/ms");
    expect(imageRepository("registry:5000/ms:1")).toBe("registry:5000/ms");
  });
});

describe("jobPolicyProblem", () => {
  const policy = defaultJobPolicy(DEFAULT_IMAGE);

  it("accepts plans without an image, and other tags or digests of the default repository", () => {
    expect(jobPolicyProblem(makePlan(), policy)).toBeUndefined();
    const pinned = makePlan("nightly", {
      job: { image: "ghcr.io/shamalrathnayake/mongoshield:2.0.0@sha256:0123" },
    });
    expect(jobPolicyProblem(pinned, policy)).toBeUndefined();
  });

  it("refuses an image from any other repository by default, and says how to allow it", () => {
    const plan = makePlan("nightly", { job: { image: "evil.example/mongoshield:2.0.1" } });
    const problem = jobPolicyProblem(plan, policy);
    expect(problem).toContain("spec.job.image");
    expect(problem).toContain("MONGOSHIELD_ALLOWED_IMAGES");
    // A look-alike prefix is not the same repository.
    const lookAlike = makePlan("nightly", {
      job: { image: "ghcr.io/shamalrathnayake/mongoshield-evil:1" },
    });
    expect(jobPolicyProblem(lookAlike, policy)).toBeDefined();
  });

  it("honours '*' and 'prefix/*' image entries", () => {
    const plan = makePlan("nightly", { job: { image: "registry.internal/team/ms:all" } });
    expect(
      jobPolicyProblem(plan, { ...policy, allowedImages: ["registry.internal/*"] }),
    ).toBeUndefined();
    expect(jobPolicyProblem(plan, { ...policy, allowedImages: ["*"] })).toBeUndefined();
    expect(
      jobPolicyProblem(plan, { ...policy, allowedImages: ["registry.other/*"] }),
    ).toBeDefined();
  });

  it("allows any service account by default, and only listed ones when restricted", () => {
    const plan = makePlan("nightly", { job: { serviceAccountName: "irsa-backups" } });
    expect(jobPolicyProblem(plan, policy)).toBeUndefined();

    // makePlan puts the plan in the fixtures' namespace.
    const namespace = plan.metadata.namespace ?? "";
    const restricted = (entries: string[]) => ({ ...policy, allowedServiceAccounts: entries });
    expect(jobPolicyProblem(plan, restricted([`${namespace}/irsa-backups`]))).toBeUndefined();
    expect(jobPolicyProblem(plan, restricted([`${namespace}/*`]))).toBeUndefined();
    expect(jobPolicyProblem(plan, restricted(["*/irsa-backups"]))).toBeUndefined();
    expect(jobPolicyProblem(plan, restricted(["other/irsa-backups"]))).toContain(
      "spec.job.serviceAccountName",
    );
    expect(jobPolicyProblem(plan, restricted([`${namespace}/admin`]))).toBeDefined();
  });
});

describe("the environment while images are restricted", () => {
  const policy = defaultJobPolicy(DEFAULT_IMAGE);
  const anyImage = { ...policy, allowedImages: ["*"] };
  const withEnv = (env: { name: string; value?: string }[]) =>
    makePlan("nightly", { job: { env } });

  it("treats every list without '*' as restricted", () => {
    expect(imagesRestricted(policy)).toBe(true);
    expect(imagesRestricted({ ...policy, allowedImages: ["registry.internal/*"] })).toBe(true);
    expect(imagesRestricted(anyImage)).toBe(false);
  });

  it("refuses variables that load or change code, and says why", () => {
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_COMPILE_CACHE",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "ld_preload",
      "DYLD_INSERT_LIBRARIES",
      "GCONV_PATH",
      "OPENSSL_CONF",
    ]) {
      const value = name === "NODE_OPTIONS" ? "--import=data:text/javascript,process.exit(9)" : "x";
      const problem = jobPolicyProblem(withEnv([{ name, value }]), policy);
      expect(problem, name).toContain(`spec.job.env "${name}" is not allowed`);
      expect(problem, name).toContain("MONGOSHIELD_ALLOWED_IMAGES");
      // With any image allowed, the plan could run that code anyway.
      expect(jobPolicyProblem(withEnv([{ name, value }]), anyImage), name).toBeUndefined();
    }
  });

  it("allows NODE_OPTIONS with heap-size and warning flags only, as a literal value", () => {
    const allowed = "--max-old-space-size=4096  --max-semi-space-size=64 --no-warnings";
    expect(jobPolicyProblem(withEnv([{ name: "NODE_OPTIONS", value: allowed }]), policy)).toBe(
      undefined,
    );
    for (const value of ["--max-old-space-size=4096 --require /tmp/x.js", "-r x", "--inspect"]) {
      expect(jobPolicyProblem(withEnv([{ name: "NODE_OPTIONS", value }]), policy)).toContain(
        "--max-old-space-size=<n>",
      );
    }
    const fromSecret = makePlan("nightly", {
      job: {
        env: [{ name: "NODE_OPTIONS", valueFrom: { secretKeyRef: { name: "s", key: "k" } } }],
      },
    });
    expect(jobPolicyProblem(fromSecret, policy)).toContain("literal value");
  });

  it("allows CA bundles and ordinary variables, but not the operator's own ones", () => {
    const ordinary = withEnv([
      { name: "NODE_EXTRA_CA_CERTS", value: "/etc/ssl/extra.pem" },
      { name: "AWS_REGION", value: "eu-west-1" },
      { name: "MONGOSHIELD_WEBHOOK_SECRET", value: "x" },
    ]);
    expect(jobPolicyProblem(ordinary, policy)).toBeUndefined();
    for (const name of ["MONGODB_URI", "MONGOSHIELD_URI", "MONGOSHIELD_PASSPHRASE"]) {
      expect(jobPolicyProblem(withEnv([{ name, value: "x" }]), policy)).toContain(
        "the operator sets it",
      );
    }
  });

  it("refuses spec.job.envFrom unless the admin allows it", () => {
    const plan = makePlan("nightly", { job: { envFrom: [{ configMapRef: { name: "extra" } }] } });
    const problem = jobPolicyProblem(plan, policy);
    expect(problem).toContain("spec.job.envFrom is not allowed");
    expect(problem).toContain("MONGOSHIELD_ALLOW_JOB_ENV_FROM");
    expect(jobPolicyProblem(plan, { ...policy, allowEnvFrom: true })).toBeUndefined();
    expect(jobPolicyProblem(plan, anyImage)).toBeUndefined();
  });

  it("pins the code-loading variables last, keeping an allowed NODE_OPTIONS", () => {
    const env = restrictedEnvironment([
      { name: "AWS_REGION", value: "eu-west-1" },
      { name: "NODE_OPTIONS", value: "--max-old-space-size=2048" },
      { name: "LD_PRELOAD", value: "/backups/evil.so" },
      { name: "LD_BIND_NOW", value: "1" },
    ]);
    const names = env.map((variable) => variable.name);
    // No duplicates, and nothing of the plan's that loads code.
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("AWS_REGION");
    expect(names).not.toContain("LD_BIND_NOW");
    const pinnedValue = (name: string) => env.find((variable) => variable.name === name)?.value;
    expect(pinnedValue("NODE_OPTIONS")).toBe("--max-old-space-size=2048");
    expect(pinnedValue("LD_PRELOAD")).toBe("");
    expect(pinnedValue("NODE_PATH")).toBe("");
    expect(pinnedValue("NODE_DISABLE_COMPILE_CACHE")).toBe("1");
    expect(pinnedValue("OPENSSL_CONF")).toBe("/dev/null");
    // An unsafe NODE_OPTIONS (an unchecked plan) is emptied, not passed on.
    const unsafe = restrictedEnvironment([{ name: "NODE_OPTIONS", value: "--import=x" }]);
    expect(unsafe.find((variable) => variable.name === "NODE_OPTIONS")?.value).toBe("");
  });
});
