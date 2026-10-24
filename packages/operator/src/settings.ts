/**
 * The operator's settings, read from environment variables (set by the Helm chart
 * or the plain manifests in deploy/operator).
 *
 * | Variable                       | Default                                  | Meaning |
 * |--------------------------------|------------------------------------------|---------|
 * | WATCH_NAMESPACES               | (all namespaces)                         | Comma-separated namespaces to manage |
 * | POD_NAMESPACE                  | from the service account, else "default" | The operator's namespace (for its Lease) |
 * | POD_NAME                       | the hostname                             | Identity in leader election and events |
 * | MONGOSHIELD_IMAGE              | ghcr.io/shamalrathnayake/mongoshield:latest | Image for backup/restore Jobs |
 * | MONGOSHIELD_IMAGE_PULL_POLICY  | (Kubernetes default)                     | Pull policy for that image |
 * | LEADER_ELECTION                | true                                     | Compete for a Lease before reconciling |
 * | LEADER_ELECTION_LEASE          | mongoshield-operator                     | Name of the Lease |
 * | HTTP_PORT                      | 8080                                     | /healthz, /readyz, /metrics |
 * | WORKERS                        | 2                                        | Parallel reconciles per kind |
 * | RESYNC_SECONDS                 | 600                                      | Re-check every object this often |
 * | LOG_LEVEL                      | info                                     | debug, info, warn or error |
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { LogLevel } from "./logger.ts";

export interface OperatorSettings {
  /** Namespaces to manage; undefined means all of them. */
  readonly watchNamespaces: readonly string[] | undefined;
  readonly operatorNamespace: string;
  readonly identity: string;
  readonly image: string;
  readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never" | undefined;
  readonly leaderElection: boolean;
  readonly leaseName: string;
  readonly httpPort: number;
  readonly workers: number;
  readonly resyncMs: number;
  readonly logLevel: LogLevel;
}

/** Where Kubernetes mounts the pod's namespace (with the service account token). */
const NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

/** Reads the settings; throws with a clear message on invalid values. */
export function readSettings(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = readText,
): OperatorSettings {
  const namespaces = list(env.WATCH_NAMESPACES);
  return {
    watchNamespaces: namespaces.length > 0 ? namespaces : undefined,
    operatorNamespace: value(env.POD_NAMESPACE) ?? serviceAccountNamespace(readFile) ?? "default",
    identity: value(env.POD_NAME) ?? hostname(),
    image: value(env.MONGOSHIELD_IMAGE) ?? "ghcr.io/shamalrathnayake/mongoshield:latest",
    imagePullPolicy: pullPolicy(value(env.MONGOSHIELD_IMAGE_PULL_POLICY)),
    leaderElection: value(env.LEADER_ELECTION) !== "false",
    leaseName: value(env.LEADER_ELECTION_LEASE) ?? "mongoshield-operator",
    httpPort: integer(env.HTTP_PORT, "HTTP_PORT", 8080),
    workers: integer(env.WORKERS, "WORKERS", 2),
    resyncMs: integer(env.RESYNC_SECONDS, "RESYNC_SECONDS", 600) * 1000,
    logLevel: logLevel(value(env.LOG_LEVEL)),
  };
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function serviceAccountNamespace(readFile: (path: string) => string): string | undefined {
  try {
    return value(readFile(NAMESPACE_FILE));
  } catch {
    // Not running in a pod (local development with a kubeconfig).
    return undefined;
  }
}

/** Empty strings count as unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function integer(raw: string | undefined, name: string, fallback: number): number {
  const text = value(raw);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${text}"`);
  }
  return parsed;
}

function pullPolicy(raw: string | undefined): OperatorSettings["imagePullPolicy"] {
  if (raw === undefined) return undefined;
  if (raw === "Always" || raw === "IfNotPresent" || raw === "Never") return raw;
  throw new Error(
    `MONGOSHIELD_IMAGE_PULL_POLICY must be Always, IfNotPresent or Never, got "${raw}"`,
  );
}

function logLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return "info";
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new Error(`LOG_LEVEL must be debug, info, warn or error, got "${raw}"`);
}
