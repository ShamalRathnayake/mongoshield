/**
 * End-to-end test runner: a real Kubernetes cluster, the real images, the Helm chart.
 *
 *   pnpm --filter @mongoshield/operator test:e2e
 *
 * Steps:
 *   1. Tools: kind and helm are downloaded into packages/operator/.tools/bin when they
 *      are not on PATH (kubectl and docker must be installed).
 *   2. Cluster: a kind cluster named mongoshield-e2e (created if missing), or, with
 *      E2E_KUBE_CONTEXT, an existing cluster such as OrbStack's (`orb start k8s`),
 *      which shares the local Docker image store.
 *   3. Images: docker/Dockerfile (CLOUD_SDKS=none: the test stores backups on a
 *      volume) and docker/operator.Dockerfile, tagged :e2e, loaded into kind.
 *   4. Install: the CRDs and operator from deploy/helm/mongoshield-operator.
 *   5. Test: vitest's e2e project (test/e2e), which deploys MongoDB, creates a plan,
 *      waits for scheduled and manual backups, restores one and checks the data.
 *   6. Cleanup: the kind cluster is deleted unless E2E_KEEP_CLUSTER=1.
 *
 * Environment:
 *   E2E_KUBE_CONTEXT   use this kubeconfig context instead of creating a kind cluster
 *   E2E_KEEP_CLUSTER   1: keep the kind cluster (faster reruns; delete it with
 *                      `kind delete cluster --name mongoshield-e2e`)
 *   E2E_SKIP_BUILD     1: reuse mongoshield:e2e and mongoshield-operator:e2e as built
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const toolsDirectory = resolve(packageRoot, ".tools/bin");

/** Pinned tool versions (bump deliberately). */
const KIND_VERSION = "v0.33.0";
const HELM_VERSION = "v4.3.1";

const CLUSTER = "mongoshield-e2e";
const OPERATOR_NAMESPACE = "mongoshield-system";
const RELEASE = "mongoshield-operator";
const JOB_IMAGE = "mongoshield:e2e";
const OPERATOR_IMAGE = "mongoshield-operator:e2e";
const MONGO_IMAGE = "mongo:8.0";

/** Runs a command with inherited output; throws when it fails. */
function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} failed with exit code ${result.status}`);
}

/** Runs a command and returns its stdout ("" when it fails). */
function capture(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** True when `command` runs. */
function available(command: string): boolean {
  return spawnSync(command, ["version"], { stdio: "ignore" }).status === 0;
}

/** Go-style platform names for download URLs. */
function goPlatform(): { os: string; cpu: string } {
  const os = platform() === "darwin" ? "darwin" : "linux";
  const cpu = arch() === "arm64" ? "arm64" : "amd64";
  return { os, cpu };
}

/** kind and helm from PATH, or downloaded into .tools/bin. */
function ensureTools(): { kind: string; helm: string } {
  mkdirSync(toolsDirectory, { recursive: true });
  const { os, cpu } = goPlatform();
  const local = (name: string): string => resolve(toolsDirectory, name);

  const kind = available("kind") ? "kind" : local("kind");
  if (kind !== "kind" && !existsSync(kind)) {
    run("curl", [
      "-fsSL",
      "-o",
      kind,
      `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${os}-${cpu}`,
    ]);
    chmodSync(kind, 0o755);
  }
  const helm = available("helm") ? "helm" : local("helm");
  if (helm !== "helm" && !existsSync(helm)) {
    const archive = resolve(toolsDirectory, "helm.tar.gz");
    run("curl", [
      "-fsSL",
      "-o",
      archive,
      `https://get.helm.sh/helm-${HELM_VERSION}-${os}-${cpu}.tar.gz`,
    ]);
    run("tar", [
      "-xzf",
      archive,
      "-C",
      toolsDirectory,
      "--strip-components=1",
      `${os}-${cpu}/helm`,
    ]);
  }
  for (const required of ["kubectl", "docker"]) {
    if (
      spawnSync(required, required === "kubectl" ? ["version", "--client"] : ["version"], {
        stdio: "ignore",
      }).status !== 0
    ) {
      throw new Error(`${required} is required for the e2e test`);
    }
  }
  return { kind, helm };
}

/** The kubeconfig context to use: the given one, or a (new) kind cluster's. */
function ensureCluster(kind: string): { context: string; createdKind: boolean } {
  const given = process.env.E2E_KUBE_CONTEXT;
  if (given) return { context: given, createdKind: false };
  const clusters = capture(kind, ["get", "clusters"]).split("\n");
  if (!clusters.includes(CLUSTER))
    run(kind, ["create", "cluster", "--name", CLUSTER, "--wait", "180s"]);
  return { context: `kind-${CLUSTER}`, createdKind: true };
}

function buildImages(): void {
  if (process.env.E2E_SKIP_BUILD === "1") return;
  run("docker", [
    "build",
    "-f",
    "docker/Dockerfile",
    "--build-arg",
    "CLOUD_SDKS=none",
    "-t",
    JOB_IMAGE,
    ".",
  ]);
  run("docker", ["build", "-f", "docker/operator.Dockerfile", "-t", OPERATOR_IMAGE, "."]);
}

/** Makes the images available to the cluster's nodes without a registry. */
function loadImages(kind: string, createdKind: boolean): void {
  if (!createdKind) return; // OrbStack and Docker Desktop share the local image store.
  for (const image of [JOB_IMAGE, OPERATOR_IMAGE]) {
    run(kind, ["load", "docker-image", image, "--name", CLUSTER]);
  }
  // MongoDB comes from Docker Hub. Preloading a local copy only saves time: a pulled
  // multi-platform image often lacks the other platforms' layers, which `kind load`
  // refuses, and then the node simply pulls it itself.
  try {
    run(kind, ["load", "docker-image", MONGO_IMAGE, "--name", CLUSTER]);
  } catch {
    process.stdout.write(`(could not preload ${MONGO_IMAGE}; the node will pull it)\n`);
  }
}

function installOperator(helm: string, context: string): void {
  // Helm installs crds/ only on the first install and never upgrades them, so apply
  // the current CRDs first (as users upgrading the operator must, too).
  run("kubectl", [
    "--context",
    context,
    "apply",
    "--server-side",
    "--force-conflicts",
    "-f",
    "deploy/operator/crds.yaml",
  ]);
  run(helm, [
    "upgrade",
    "--install",
    RELEASE,
    "deploy/helm/mongoshield-operator",
    "--kube-context",
    context,
    "--namespace",
    OPERATOR_NAMESPACE,
    "--create-namespace",
    "--set",
    "image.repository=mongoshield-operator",
    "--set",
    "image.tag=e2e",
    "--set",
    "image.pullPolicy=IfNotPresent",
    "--set",
    "jobImage.repository=mongoshield",
    "--set",
    "jobImage.tag=e2e",
    "--set",
    "jobImage.pullPolicy=IfNotPresent",
    "--set",
    "logLevel=debug",
    "--wait",
    "--timeout",
    "180s",
  ]);
  // A rebuilt image with the same tag needs a restart to be picked up.
  run("kubectl", [
    "--context",
    context,
    "-n",
    OPERATOR_NAMESPACE,
    "rollout",
    "restart",
    `deployment/${RELEASE}`,
  ]);
  run("kubectl", [
    "--context",
    context,
    "-n",
    OPERATOR_NAMESPACE,
    "rollout",
    "status",
    `deployment/${RELEASE}`,
    "--timeout",
    "180s",
  ]);
}

async function main(): Promise<void> {
  const { kind, helm } = ensureTools();
  const { context, createdKind } = ensureCluster(kind);
  let failed = false;
  try {
    buildImages();
    loadImages(kind, createdKind);
    installOperator(helm, context);
    run("npx", ["vitest", "run", "--project", "e2e"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        MONGOSHIELD_E2E_CONTEXT: context,
        MONGOSHIELD_E2E_OPERATOR_NAMESPACE: OPERATOR_NAMESPACE,
        MONGOSHIELD_E2E_RELEASE: RELEASE,
        MONGOSHIELD_E2E_MONGO_IMAGE: MONGO_IMAGE,
      },
    });
  } catch (error) {
    failed = true;
    process.stderr.write(
      `\ne2e failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    // The operator's log is the first thing to look at.
    try {
      run("kubectl", [
        "--context",
        context,
        "-n",
        OPERATOR_NAMESPACE,
        "logs",
        `deployment/${RELEASE}`,
        "--tail",
        "200",
      ]);
    } catch {
      // No operator to read from (the install itself failed).
    }
  } finally {
    if (createdKind && process.env.E2E_KEEP_CLUSTER !== "1") {
      run(kind, ["delete", "cluster", "--name", CLUSTER]);
    }
  }
  if (failed) process.exit(1);
}

await main();
