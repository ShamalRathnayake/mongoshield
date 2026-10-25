/**
 * Writes deploy/operator/operator.yaml, the plain-manifest install (for people who
 * don't use Helm), by rendering the Helm chart with its defaults. One source of
 * truth: the chart. The CRDs are in deploy/operator/crds.yaml (generate-crds.ts).
 *
 *   node scripts/generate-manifests.ts           write the file
 *   node scripts/generate-manifests.ts --check   fail if it is out of date
 *
 * Needs `helm` (v3 or v4) on PATH, or in packages/operator/.tools/bin (where
 * scripts/e2e.ts downloads it).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const output = resolve(repositoryRoot, "deploy/operator/operator.yaml");
const NAMESPACE = "mongoshield-system";

const HEADER = `# MongoShield operator: plain Kubernetes manifests (namespace ${NAMESPACE}).
#
#   kubectl apply --server-side -f deploy/operator/crds.yaml
#   kubectl apply -f deploy/operator/operator.yaml
#
# GENERATED from the Helm chart (deploy/helm/mongoshield-operator) with its default
# values: do not edit by hand. Regenerate with:
#   pnpm --filter @mongoshield/operator manifests
#
# Before applying, pin the images: replace the operator image tag "next" and the
# MONGOSHIELD_IMAGE tag "latest" with released versions.
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: mongoshield
    # The operator pod satisfies the "restricted" Pod Security Standard (so do the
    # backup and restore Jobs it creates in your namespaces).
    pod-security.kubernetes.io/enforce: restricted
`;

function helmBinary(): string {
  const local = resolve(packageRoot, ".tools/bin/helm");
  return existsSync(local) ? local : "helm";
}

function render(): string {
  const chart = resolve(repositoryRoot, "deploy/helm/mongoshield-operator");
  const rendered = execFileSync(
    helmBinary(),
    ["template", "mongoshield-operator", chart, "--namespace", NAMESPACE, "--skip-crds"],
    { encoding: "utf8" },
  );
  // Helm labels resources with its own name; these were not installed by Helm.
  const relabelled = rendered
    .replace(/^\s*helm\.sh\/chart: .*\n/gm, "")
    .replace(/app\.kubernetes\.io\/managed-by: Helm/g, "app.kubernetes.io/managed-by: kubectl");
  return `${HEADER}${relabelled.startsWith("---") ? "" : "---\n"}${relabelled}`;
}

const expected = render();
if (process.argv.includes("--check")) {
  const actual = await readFile(output, "utf8").catch(() => "");
  if (actual !== expected) {
    process.stderr.write(
      "deploy/operator/operator.yaml is out of date. Run: pnpm --filter @mongoshield/operator manifests\n",
    );
    process.exit(1);
  }
} else {
  await writeFile(output, expected);
  process.stdout.write("wrote deploy/operator/operator.yaml\n");
}
