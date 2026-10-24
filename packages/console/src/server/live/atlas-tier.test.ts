/**
 * Unit tests for Atlas shared-tier detection with fake clients: Atlas host + refused
 * probe → shared, Atlas host + answered probe → dedicated, other hosts → never probed,
 * the per-client cache, and marking a client after a `$collStats` refusal.
 */

import { type MongoClient, MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { atlasHostsOf, isSharedTier, markSharedTier, SHARED_TIER_PROBE } from "./atlas-tier.ts";

/** The refusal shared tiers answer the probe with. */
function atlasError(): MongoServerError {
  return new MongoServerError({
    message: "getParameter is not allowed in this atlas tier",
    code: 8000,
    codeName: "AtlasError",
  });
}

/**
 * A fake client: the host names the driver would have parsed, and an admin `command`
 * that behaves like `reply` (a value to answer, or an error to throw).
 */
function fakeClient(options: { srvHost?: string; hosts?: string[] }, reply: unknown) {
  const command = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const client = {
    options: { srvHost: options.srvHost, hosts: options.hosts ?? [] },
    db: vi.fn(() => ({ command })),
  } as unknown as MongoClient;
  return { client, command };
}

describe("Atlas shared-tier detection", () => {
  it("calls an Atlas cluster that refuses the probe with AtlasError a shared tier", async () => {
    const { client, command } = fakeClient({ srvHost: "cluster0.abcde.mongodb.net" }, atlasError());
    expect(await isSharedTier(client)).toBe(true);
    expect(command).toHaveBeenCalledWith(SHARED_TIER_PROBE);
  });

  it("calls an Atlas cluster that answers the probe dedicated", async () => {
    const { client } = fakeClient(
      { hosts: ["cluster0-shard-00-00.abcde.mongodb.net:27017"] },
      { featureCompatibilityVersion: { version: "8.0" }, ok: 1 },
    );
    expect(await isSharedTier(client)).toBe(false);
  });

  it("calls a dedicated cluster refusing the probe for privileges (code 13) dedicated", async () => {
    const unauthorized = new MongoServerError({
      message: "not authorized on admin to execute command",
      code: 13,
      codeName: "Unauthorized",
    });
    const { client } = fakeClient({ srvHost: "c.abcde.mongodb.net" }, unauthorized);
    expect(await isSharedTier(client)).toBe(false);
  });

  it("never probes a deployment that is not on Atlas", async () => {
    const { client, command } = fakeClient({ hosts: ["db.internal:27017", "localhost:27018"] }, {});
    expect(await isSharedTier(client)).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(atlasHostsOf(client)).toEqual([]);
  });

  it("probes once per client, also for concurrent requests", async () => {
    const { client, command } = fakeClient({ srvHost: "cluster0.abcde.mongodb.net" }, atlasError());
    const answers = await Promise.all([isSharedTier(client), isSharedTier(client)]);
    expect(answers).toEqual([true, true]);
    expect(await isSharedTier(client)).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    // Another client (a rebuilt one) asks again.
    const rebuilt = fakeClient({ srvHost: "cluster0.abcde.mongodb.net" }, atlasError());
    expect(await isSharedTier(rebuilt.client)).toBe(true);
    expect(rebuilt.command).toHaveBeenCalledTimes(1);
  });

  it("remembers an Atlas refusal of $collStats as proof, without probing", async () => {
    const { client, command } = fakeClient({ srvHost: "cluster0.abcde.mongodb.net" }, {});
    markSharedTier(client);
    expect(await isSharedTier(client)).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });

  it("lists the SRV name and the Atlas seed hosts", () => {
    const { client } = fakeClient(
      { srvHost: "cluster0.abcde.mongodb.net", hosts: ["a.abcde.mongodb.net:27017", "x.local"] },
      {},
    );
    expect(atlasHostsOf(client)).toEqual([
      "cluster0.abcde.mongodb.net",
      "a.abcde.mongodb.net:27017",
    ]);
  });
});
