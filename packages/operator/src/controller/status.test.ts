/** Tests for status writes and finalizer helpers. */

import { describe, expect, it } from "vitest";
import { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import type { BackupStatus } from "../api/types.ts";
import { RESOURCES } from "../kube/client.ts";
import type { KubeObject } from "../kube/objects.ts";
import { addFinalizer, hasFinalizer, removeFinalizer, syncFinalizers } from "./finalizers.ts";
import { updateStatus } from "./status.ts";

type WithStatus = KubeObject & { spec: object; status?: BackupStatus };

async function stored(client: FakeKubeClient): Promise<WithStatus> {
  return client.create<WithStatus>(RESOURCES.backups, "prod", {
    metadata: { name: "b", namespace: "prod" },
    spec: { planRef: { name: "p" } },
  });
}

describe("updateStatus", () => {
  it("writes only when the status changed, and nulls removed fields", async () => {
    const client = new FakeKubeClient();
    const object = await stored(client);

    const first = await updateStatus(client, RESOURCES.backups, object, {
      phase: "Running",
      jobName: "j",
    } as BackupStatus);
    expect(first.status).toEqual({ phase: "Running", jobName: "j" });

    const same = await updateStatus(client, RESOURCES.backups, first, {
      phase: "Running",
      jobName: "j",
    } as BackupStatus);
    expect(same).toBe(first);

    const second = await updateStatus(client, RESOURCES.backups, first, {
      phase: "Failed",
    } as BackupStatus);
    expect(second.status).toEqual({ phase: "Failed" });
  });

  it("is conditional on the resourceVersion it read", async () => {
    const client = new FakeKubeClient();
    const object = await stored(client);
    await client.mergePatch(RESOURCES.backups, "prod", "b", { metadata: { labels: { x: "1" } } });
    await expect(
      updateStatus(client, RESOURCES.backups, object, { phase: "Running" } as BackupStatus),
    ).rejects.toThrow("modified");
  });
});

describe("finalizers", () => {
  it("syncs several finalizers in one write, leaving unnamed ones alone", async () => {
    const client = new FakeKubeClient();
    const object = await addFinalizer(
      client,
      RESOURCES.backups,
      await stored(client),
      "other/keep",
    );
    const synced = await syncFinalizers(client, RESOURCES.backups, object, {
      "a/one": true,
      "b/two": false,
    });
    expect(synced.metadata.finalizers).toEqual(["other/keep", "a/one"]);
    // Nothing to change: no write.
    expect(await syncFinalizers(client, RESOURCES.backups, synced, { "a/one": true })).toBe(synced);
    const removed = await syncFinalizers(client, RESOURCES.backups, synced, { "a/one": false });
    expect(removed.metadata.finalizers).toEqual(["other/keep"]);
  });

  it("adds once and removes cleanly", async () => {
    const client = new FakeKubeClient();
    const object = await stored(client);
    const withFinalizer = await addFinalizer(client, RESOURCES.backups, object, "x/y");
    expect(hasFinalizer(withFinalizer, "x/y")).toBe(true);
    expect(await addFinalizer(client, RESOURCES.backups, withFinalizer, "x/y")).toBe(withFinalizer);

    await removeFinalizer(client, RESOURCES.backups, withFinalizer, "x/y");
    expect(client.object<WithStatus>(RESOURCES.backups, "prod", "b")?.metadata.finalizers).toEqual(
      [],
    );
    // Removing a finalizer that is not there writes nothing.
    const writes = client.calls.length;
    await removeFinalizer(client, RESOURCES.backups, object, "absent");
    expect(client.calls.length).toBe(writes);
  });
});
