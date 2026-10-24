import { describe, expect, it } from "vitest";
import { parseKmsLabel } from "./rekey.ts";

describe("parseKmsLabel", () => {
  it("reads the provider and key of a KMS recipient label", () => {
    expect(parseKmsLabel("kms:aws:arn:aws:kms:eu-west-1:1:key/abc")).toEqual({
      provider: "aws",
      key: "arn:aws:kms:eu-west-1:1:key/abc",
    });
    expect(parseKmsLabel("kms:gcp:projects/p/keys/k")?.provider).toBe("gcp");
    expect(parseKmsLabel("kms:azure:https://v.vault.azure.net/keys/k")?.provider).toBe("azure");
  });

  it.each([
    ["an age recipient", "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq"],
    ["a label without a key", "kms:aws:"],
    ["a label without a provider", "kms::key"],
    ["a label without any separator", "kms:aws"],
    ["an unknown provider", "kms:oracle:key"],
  ])("returns nothing for %s", (_name, label) => {
    expect(parseKmsLabel(label)).toBeUndefined();
  });
});
