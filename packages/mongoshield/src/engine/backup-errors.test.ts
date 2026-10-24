// Unit tests for toBackupError: which driver errors become which MongoShield codes.
// The election cases matter for scheduled runs, which retry only transient codes
// (the 3-member replica set suite in test/topology shows them on a real server).

import { MongoNetworkError, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoShieldError } from "../errors.ts";
import { isTransientError } from "../schedule/retry.ts";
import { toBackupError } from "./backup-errors.ts";

/** A server error as the driver raises it. */
function serverError(code: number, codeName: string): MongoServerError {
  return new MongoServerError({ ok: 0, code, codeName, errmsg: `${codeName} happened` });
}

describe("toBackupError", () => {
  it.each([
    [11602, "InterruptedDueToReplStateChange"],
    [189, "PrimarySteppedDown"],
    [10107, "NotWritablePrimary"],
    [13435, "NotPrimaryNoSecondaryOk"],
    [13436, "NotPrimaryOrSecondary"],
    [91, "ShutdownInProgress"],
    [11600, "InterruptedAtShutdown"],
  ])("treats %i (%s) as a retryable connection failure", (code, codeName) => {
    const error = toBackupError(serverError(code, codeName), { ns: "app.orders" });
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(error.message).toContain("while reading app.orders");
    expect(error.details).toEqual({ serverCode: code });
    expect(isTransientError(error)).toBe(true);
  });

  it("tells an expired snapshot from a collection whose catalog changed under it", () => {
    const expired = toBackupError(serverError(239, "SnapshotTooOld"));
    expect(expired.code).toBe("MS_SNAPSHOT_TOO_OLD");
    const changed = toBackupError(
      new MongoServerError({
        ok: 0,
        code: 246,
        codeName: "SnapshotUnavailable",
        errmsg:
          "Collection app.summary has undergone a catalog change and no longer satisfies the requirements for the current transaction.",
      }),
    );
    expect(changed.code).toBe("MS_UNSUPPORTED_TOPOLOGY");
    expect(changed.message).toContain("catalog change");
    expect(changed.hint).toContain("$out");
  });

  it("turns Unauthorized into MS_PERMISSION_DENIED with a role hint", () => {
    const error = toBackupError(serverError(13, "Unauthorized"));
    expect(error.code).toBe("MS_PERMISSION_DENIED");
    expect(error.hint).toContain("`backup`");
    expect(isTransientError(error)).toBe(false);
  });

  it("turns network errors into MS_CONNECTION_FAILED", () => {
    expect(toBackupError(new MongoNetworkError("socket closed")).code).toBe("MS_CONNECTION_FAILED");
  });

  it("keeps other server errors as MS_INTERNAL, which is not retried", () => {
    const error = toBackupError(serverError(2, "BadValue"));
    expect(error.code).toBe("MS_INTERNAL");
    expect(isTransientError(error)).toBe(false);
  });

  it("passes MongoShield errors through unchanged", () => {
    const original = new MongoShieldError("MS_STORAGE_IO", "disk full");
    expect(toBackupError(original)).toBe(original);
  });
});
