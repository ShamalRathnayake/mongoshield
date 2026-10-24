// Unit tests for how a snapshot reset decides what to do with each namespace.

import { describe, expect, it } from "vitest";
import { type Fingerprints, type NamespaceFingerprint, planReset } from "./reset.ts";

function fingerprint(overrides: Partial<NamespaceFingerprint> = {}): NamespaceFingerprint {
  return { type: "collection", structure: "s1", dataHash: "h1", reloadable: true, ...overrides };
}

function decide(
  reference: NamespaceFingerprint | undefined,
  current: NamespaceFingerprint | undefined,
): string | undefined {
  const before: Fingerprints = new Map(reference ? [["app.c", reference]] : []);
  const now: Fingerprints = new Map(current ? [["app.c", current]] : []);
  return planReset(["app.c"], before, now).get("app.c");
}

describe("planReset", () => {
  it("keeps a namespace whose structure and documents are unchanged", () => {
    expect(decide(fingerprint(), fingerprint())).toBe("keep");
    expect(
      decide(
        fingerprint({ type: "view", dataHash: undefined }),
        fingerprint({ type: "view", dataHash: undefined }),
      ),
    ).toBe("keep");
  });

  it("reloads documents when only the data changed", () => {
    expect(decide(fingerprint(), fingerprint({ dataHash: "h2" }))).toBe("reload");
    // No hash available (e.g. no dbHash privilege): assume changed.
    expect(decide(fingerprint(), fingerprint({ dataHash: undefined }))).toBe("reload");
  });

  it("recreates namespaces that are gone, changed structure, or cannot be reloaded", () => {
    expect(decide(fingerprint(), undefined)).toBe("recreate");
    expect(decide(fingerprint(), fingerprint({ structure: "s2" }))).toBe("recreate");
    expect(decide(fingerprint(), fingerprint({ dataHash: "h2", reloadable: false }))).toBe(
      "recreate",
    );
  });
});
