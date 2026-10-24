// Unit tests for recognising MongoDB Atlas and its Free/Flex tiers (atlas.ts). Real
// Atlas clusters cannot be reached from the test suite, so the client, the `hello`
// reply and the probe's answer are faked from what the Atlas documentation describes:
// Atlas host names, and code 8000 (AtlasError) for commands a tier refuses.

import { type Document, type MongoClient, MongoNetworkError, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  ATLAS_ERROR_CODE,
  detectAtlas,
  isAtlasHost,
  isAtlasRefusal,
  isAtlasSharedTier,
} from "./atlas.ts";
import { describeDeployment } from "./deployment.ts";

/** The refusal an Atlas Free/Flex proxy sends for a command the tier does not allow. */
function atlasRefusal(
  message = "getParameter is not allowed in this atlas tier",
): MongoServerError {
  return new MongoServerError({
    ok: 0,
    errmsg: message,
    code: ATLAS_ERROR_CODE,
    codeName: "AtlasError",
  });
}

/** Just the parts of a MongoClient that detection reads: the SRV name and seed hosts. */
function fakeClient(options: { srvHost?: string; hosts?: readonly string[] }): MongoClient {
  const hosts = (options.hosts ?? []).map((host) => ({ toString: () => host }));
  return { options: { hosts, srvHost: options.srvHost } } as unknown as MongoClient;
}

/** A probe that records the commands it gets and answers with `answer`. */
function recordingProbe(answer: () => unknown) {
  const commands: Document[] = [];
  return {
    commands,
    probe: async (command: Document) => {
      commands.push(command);
      return answer();
    },
  };
}

describe("isAtlasHost", () => {
  it.each([
    "cluster0.abcde.mongodb.net",
    "cluster0-shard-00-00.abcde.mongodb.net:27017",
    "ac-x1y2z3-shard-00-01.abcde.mongodb.net:27017",
    "CLUSTER0.ABCDE.MONGODB.NET",
    "cluster0.abcde.mongodbgov.net",
    "cluster0.abcde.mongodb-dev.net",
  ])("recognises %s", (host) => {
    expect(isAtlasHost(host)).toBe(true);
  });

  it.each([
    "localhost:27017",
    "db.example.com",
    "mongodb.net.example.com",
    "[::1]:27017",
    "::1",
    "10.0.0.1:27017",
  ])("does not mistake %s for Atlas", (host) => {
    expect(isAtlasHost(host)).toBe(false);
  });

  it("strips the port of bracketed IPv6 hosts before comparing", () => {
    // Not a real Atlas host, but proves the port is removed from bracketed forms.
    expect(isAtlasHost("[cluster0.abcde.mongodb.net]:27017")).toBe(true);
  });
});

describe("isAtlasRefusal", () => {
  it("recognises the AtlasError code, the code name and the documented messages", () => {
    expect(isAtlasRefusal(atlasRefusal())).toBe(true);
    expect(isAtlasRefusal(new MongoServerError({ errmsg: "x", codeName: "AtlasError" }))).toBe(
      true,
    );
    expect(
      isAtlasRefusal(
        new MongoServerError({
          errmsg:
            "command dbStats is not allowed in this Atlas tier(Unauthorized) not authorized on local to execute command",
          code: 13,
        }),
      ),
    ).toBe(true);
    expect(
      isAtlasRefusal(
        new MongoServerError({
          errmsg:
            "$where is not allowed or the syntax is incorrect, see the Atlas documentation for more information",
        }),
      ),
    ).toBe(true);
  });

  it("does not treat ordinary server errors or other errors as Atlas refusals", () => {
    expect(isAtlasRefusal(new MongoServerError({ errmsg: "not authorized", code: 13 }))).toBe(
      false,
    );
    expect(isAtlasRefusal(new MongoNetworkError("connection reset"))).toBe(false);
    expect(isAtlasRefusal(new Error("AtlasError"))).toBe(false);
    expect(isAtlasRefusal("AtlasError")).toBe(false);
  });
});

describe("detectAtlas", () => {
  it("returns undefined, without sending anything, when no host is on Atlas", async () => {
    const { probe, commands } = recordingProbe(() => ({ ok: 1 }));
    const client = fakeClient({ hosts: ["localhost:27017"] });
    expect(
      await detectAtlas(client, { hosts: ["localhost:27017"], me: "localhost:27017" }, probe),
    ).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it("reports a shared tier when the probe is refused with AtlasError", async () => {
    const { probe, commands } = recordingProbe(() => {
      throw atlasRefusal();
    });
    const client = fakeClient({ srvHost: "cluster0.abcde.mongodb.net" });
    const info = await detectAtlas(client, {}, probe);
    expect(info).toEqual({
      tier: "shared",
      signals: ["host cluster0.abcde.mongodb.net", "getParameter refused with AtlasError"],
    });
    expect(commands).toEqual([{ getParameter: 1, featureCompatibilityVersion: 1 }]);
  });

  it("reports a dedicated cluster when the probe is answered", async () => {
    const { probe } = recordingProbe(() => ({ featureCompatibilityVersion: { version: "8.0" } }));
    const client = fakeClient({ hosts: ["cluster0-shard-00-00.abcde.mongodb.net:27017"] });
    expect(await detectAtlas(client, {}, probe)).toEqual({
      tier: "dedicated",
      signals: ["host cluster0-shard-00-00.abcde.mongodb.net"],
    });
  });

  it("reports a dedicated cluster when the probe is refused for lack of privileges", async () => {
    const { probe } = recordingProbe(() => {
      throw new MongoServerError({ errmsg: "not authorized on admin", code: 13 });
    });
    const info = await detectAtlas(fakeClient({ srvHost: "c.abcde.mongodb.net" }), {}, probe);
    expect(info?.tier).toBe("dedicated");
  });

  it("never fails on an unexpected probe failure: it reads as dedicated", async () => {
    const { probe } = recordingProbe(() => {
      throw new MongoNetworkError("connection reset");
    });
    const info = await detectAtlas(fakeClient({ srvHost: "c.abcde.mongodb.net" }), {}, probe);
    expect(info?.tier).toBe("dedicated");
  });

  it("finds Atlas members in the hello reply when the seed list hides them", async () => {
    const { probe } = recordingProbe(() => {
      throw atlasRefusal();
    });
    // A tunnel or proxy on localhost, but the replica set reports its real members.
    const client = fakeClient({ hosts: ["localhost:27017"] });
    const hello = {
      hosts: ["ac-1-shard-00-00.abcde.mongodb.net:27017", 42],
      passives: "not a list",
      primary: "ac-1-shard-00-00.abcde.mongodb.net:27017",
    };
    const info = await detectAtlas(client, hello, probe);
    expect(info?.tier).toBe("shared");
    expect(info?.signals[0]).toBe("host ac-1-shard-00-00.abcde.mongodb.net");
  });

  it("also reads hello's me, arbiters and passives", async () => {
    const { probe } = recordingProbe(() => ({ ok: 1 }));
    const client = fakeClient({ hosts: ["localhost:27017"] });
    for (const hello of [
      { me: "a.abcde.mongodb.net:27017" },
      { arbiters: ["a.abcde.mongodb.net:27017"] },
      { passives: ["a.abcde.mongodb.net:27017"] },
    ]) {
      expect((await detectAtlas(client, hello, probe))?.tier).toBe("dedicated");
    }
  });

  it("runs the probe on the admin database by default", async () => {
    const commands: Document[] = [];
    const client = {
      options: { hosts: [], srvHost: "cluster0.abcde.mongodb.net" },
      db: (name: string) => ({
        command: async (command: Document) => {
          commands.push({ db: name, ...command });
          throw atlasRefusal();
        },
      }),
    } as unknown as MongoClient;
    expect((await detectAtlas(client, {}))?.tier).toBe("shared");
    expect(commands).toEqual([{ db: "admin", getParameter: 1, featureCompatibilityVersion: 1 }]);
  });
});

describe("isAtlasSharedTier", () => {
  it("is true only for a detected shared tier", () => {
    expect(isAtlasSharedTier({ atlas: { tier: "shared", signals: [] } })).toBe(true);
    expect(isAtlasSharedTier({ atlas: { tier: "dedicated", signals: [] } })).toBe(false);
    expect(isAtlasSharedTier({})).toBe(false);
  });
});

describe("describeDeployment on Atlas", () => {
  /** A fake Atlas Free cluster: an ordinary replica set whose proxy refuses getParameter. */
  function atlasFreeCluster(): { client: MongoClient; commands: string[] } {
    const commands: string[] = [];
    const client = {
      options: {
        hosts: [{ toString: () => "ac-1-shard-00-00.abcde.mongodb.net:27017" }],
        srvHost: "cluster0.abcde.mongodb.net",
      },
      db: () => ({
        command: async (command: Document) => {
          const name = Object.keys(command)[0] ?? "";
          commands.push(name);
          if (name === "hello") return { setName: "atlas-abc123-shard-0", isWritablePrimary: true };
          if (name === "buildInfo") return { version: "8.0.15" };
          throw atlasRefusal();
        },
      }),
    } as unknown as MongoClient;
    return { client, commands };
  }

  it("records the shared tier, and sends the probe after hello and buildInfo", async () => {
    const { client, commands } = atlasFreeCluster();
    const info = await describeDeployment(client);
    expect(info.atlas?.tier).toBe("shared");
    expect(info.topology).toBe("replicaSet");
    expect(info.supportsChangeStreams).toBe(true);
    expect(commands).toEqual(["hello", "buildInfo", "getParameter"]);
  });

  it("leaves atlas out for deployments that are not on Atlas", async () => {
    const client = {
      options: { hosts: [{ toString: () => "localhost:27017" }] },
      db: () => ({
        command: async (command: Document) =>
          "hello" in command ? { setName: "rs0", isWritablePrimary: true } : { version: "8.0.0" },
      }),
    } as unknown as MongoClient;
    const info = await describeDeployment(client);
    expect(info).not.toHaveProperty("atlas");
  });
});
