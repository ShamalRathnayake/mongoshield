/** Tests for the list-watch informer against the fake API server. */

import { afterEach, describe, expect, it } from "vitest";
import { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import { silentLogger } from "../logger.ts";
import { KubeApiError, RESOURCES } from "./client.ts";
import { type ChangeType, Informer } from "./informer.ts";
import type { ConfigMap } from "./objects.ts";

const stops: AbortController[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();
});

/** Starts an informer over config maps; returns it and a log of the changes it reported. */
function startInformer(
  client: FakeKubeClient,
  options: { namespaces?: string[]; labelSelector?: string } = {},
) {
  const informer = new Informer<ConfigMap>(client, {
    type: RESOURCES.configMaps,
    logger: silentLogger,
    backoff: { initialMs: 1, maxMs: 4 },
    watchTimeoutSeconds: [1, 1],
    ...options,
  });
  const changes: { change: ChangeType; name: string; previous?: string }[] = [];
  informer.onChange((change, object, previous) => {
    changes.push({
      change,
      name: object.metadata.name ?? "",
      ...(previous ? { previous: previous.data?.value ?? "" } : {}),
    });
  });
  const stop = new AbortController();
  stops.push(stop);
  informer.start(stop.signal);
  return { informer, changes, stop };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error("condition never became true");
}

const configMap = (
  name: string,
  value = "1",
  namespace = "prod",
  labels: Record<string, string> = {},
): ConfigMap => ({
  metadata: { name, namespace, labels },
  data: { value },
});

describe("Informer", () => {
  it("lists first (reporting adds), then follows the watch", async () => {
    const client = new FakeKubeClient();
    await client.create(RESOURCES.configMaps, "prod", configMap("a"));
    const { informer, changes } = startInformer(client);
    await until(() => informer.hasSynced());
    expect(changes).toEqual([{ change: "add", name: "a" }]);

    await until(() => client.openWatches === 1);
    await client.create(RESOURCES.configMaps, "prod", configMap("b"));
    const a = client.object<ConfigMap>(RESOURCES.configMaps, "prod", "a");
    await client.replace(RESOURCES.configMaps, "prod", {
      ...(a as ConfigMap),
      data: { value: "2" },
    });
    await client.delete(RESOURCES.configMaps, "prod", "b");
    await until(() => changes.length === 4);

    expect(changes.slice(1)).toEqual([
      { change: "add", name: "b" },
      { change: "update", name: "a", previous: "1" },
      { change: "delete", name: "b", previous: "1" },
    ]);
    expect(informer.get("prod", "a")?.data?.value).toBe("2");
    expect(informer.get("prod", "b")).toBeUndefined();
    expect(informer.list().map((object) => object.metadata.name)).toEqual(["a"]);
    expect(informer.list("other")).toEqual([]);
  });

  it("re-watches from the last version when the server closes the stream, missing nothing", async () => {
    const client = new FakeKubeClient();
    const { informer, changes } = startInformer(client);
    await until(() => informer.hasSynced() && client.openWatches === 1);

    client.closeWatches();
    // Created while no watch is open: the next watch replays it from history.
    await client.create(RESOURCES.configMaps, "prod", configMap("while-away"));
    await until(() => changes.length === 1);

    expect(changes).toEqual([{ change: "add", name: "while-away" }]);
    const lists = client.calls.filter((call) => call.verb === "list").length;
    expect(lists).toBe(1);
  });

  it("lists again after 410 Gone, and reports objects deleted meanwhile", async () => {
    const client = new FakeKubeClient();
    await client.create(RESOURCES.configMaps, "prod", configMap("old"));
    const { informer, changes } = startInformer(client);
    await until(() => informer.hasSynced() && client.openWatches === 1);

    // All in one synchronous step, so no watch is open while it happens: the stream
    // ends, an object is deleted and another created, and the history the informer
    // would resume from is compacted away.
    client.closeWatches();
    void client.delete(RESOURCES.configMaps, "prod", "old");
    void client.create(RESOURCES.configMaps, "prod", configMap("new"));
    client.compactHistory();
    await until(() => changes.length === 3);

    expect(changes).toEqual([
      { change: "add", name: "old" },
      { change: "add", name: "new" },
      { change: "delete", name: "old", previous: "1" },
    ]);
    expect(client.calls.filter((call) => call.verb === "list").length).toBe(2);
  });

  it("retries a failing list with backoff", async () => {
    const client = new FakeKubeClient();
    client.failNext("list", new KubeApiError(503, "ServiceUnavailable", "apiserver restarting"));
    client.failNext("list", new KubeApiError(503, "ServiceUnavailable", "apiserver restarting"));
    const { informer } = startInformer(client);

    await informer.waitForSync(new AbortController().signal, 1);

    expect(client.calls.filter((call) => call.verb === "list").length).toBe(3);
  });

  it("retries a failing watch without relisting", async () => {
    const client = new FakeKubeClient();
    client.failNext("watch", new Error("connection reset"));
    const { informer, changes } = startInformer(client);
    await until(() => informer.hasSynced() && client.openWatches === 1);
    await client.create(RESOURCES.configMaps, "prod", configMap("x"));
    await until(() => changes.length === 1);
    expect(client.calls.filter((call) => call.verb === "list").length).toBe(1);
  });

  it("watches only the given namespaces and labels", async () => {
    const client = new FakeKubeClient();
    await client.create(
      RESOURCES.configMaps,
      "prod",
      configMap("mine", "1", "prod", { managed: "yes" }),
    );
    await client.create(RESOURCES.configMaps, "prod", configMap("unlabelled", "1", "prod"));
    await client.create(
      RESOURCES.configMaps,
      "dev",
      configMap("other-ns", "1", "dev", { managed: "yes" }),
    );
    await client.create(
      RESOURCES.configMaps,
      "staging",
      configMap("staged", "1", "staging", { managed: "yes" }),
    );
    const { informer } = startInformer(client, {
      namespaces: ["prod", "staging"],
      labelSelector: "managed=yes",
    });
    await until(() => informer.hasSynced());

    expect(
      informer
        .list()
        .map((object) => object.metadata.name)
        .sort(),
    ).toEqual(["mine", "staged"]);
  });

  it("keeps going when a change handler throws", async () => {
    const client = new FakeKubeClient();
    await client.create(RESOURCES.configMaps, "prod", configMap("a"));
    const informer = new Informer<ConfigMap>(client, {
      type: RESOURCES.configMaps,
      logger: silentLogger,
    });
    informer.onChange(() => {
      throw new Error("handler bug");
    });
    const stop = new AbortController();
    stops.push(stop);
    informer.start(stop.signal);
    await until(() => informer.hasSynced());
    expect(informer.get("prod", "a")).toBeDefined();
    expect(informer.type).toBe(RESOURCES.configMaps);
  });

  it("stops all loops when the signal aborts", async () => {
    const client = new FakeKubeClient();
    const { informer, stop } = startInformer(client, { namespaces: ["a", "b"] });
    await until(() => informer.hasSynced() && client.openWatches === 2);
    stop.abort();
    await informer.stopped();
    expect(client.openWatches).toBe(0);
  });
});
