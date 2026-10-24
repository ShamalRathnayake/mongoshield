/**
 * The CRDs as a YAML manifest: what scripts/generate-crds.ts writes into the Helm
 * chart (deploy/helm/mongoshield-operator/crds/) and the plain manifests
 * (deploy/operator/crds.yaml), and what crds:check compares those files against.
 */

// js-yaml directly: @kubernetes/client-node's dumpYaml first maps objects through its
// model classes, which silently drops JSON keys such as `enum` and
// `x-kubernetes-validations` (it expects `_enum`, `xKubernetesValidations`).
import { dump } from "js-yaml";
import { ALL_CRDS } from "./crds.ts";

/** Header of every generated file, so nobody edits the copies by hand. */
const HEADER = [
  "# MongoShield CustomResourceDefinitions (mongoshield.io/v1alpha1).",
  "# GENERATED from packages/operator/src/api/crds.ts: do not edit by hand.",
  "# Regenerate with: pnpm --filter @mongoshield/operator crds",
].join("\n");

/** All CRDs as one multi-document YAML file. */
export function renderCrdsYaml(): string {
  const documents = ALL_CRDS.map((crd) =>
    // lineWidth -1: never fold long descriptions or CEL rules across lines.
    dump(crd, { lineWidth: -1, noRefs: true }).trimEnd(),
  );
  return `${HEADER}\n---\n${documents.join("\n---\n")}\n`;
}
