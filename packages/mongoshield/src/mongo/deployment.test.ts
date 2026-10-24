// Unit tests for topology classification from `hello` replies. Replies for topologies
// the test server cannot be (mongos, uninitiated replica set) are written by hand from
// the MongoDB documentation.

import { describe, expect, it } from "vitest";
import { topologyFromHello } from "./deployment.ts";

describe("topologyFromHello", () => {
  it("recognises a mongos router by msg: isdbgrid", () => {
    expect(topologyFromHello({ msg: "isdbgrid", isWritablePrimary: true })).toBe("sharded");
  });

  it("recognises a replica set member by its setName", () => {
    expect(topologyFromHello({ setName: "rs0", isWritablePrimary: false, secondary: true })).toBe(
      "replicaSet",
    );
  });

  it("recognises a standalone server from hello or legacy isMaster replies", () => {
    expect(topologyFromHello({ isWritablePrimary: true })).toBe("standalone");
    expect(topologyFromHello({ ismaster: true })).toBe("standalone");
  });

  it("reports an uninitiated replica set member as unknown", () => {
    expect(topologyFromHello({ isreplicaset: true, isWritablePrimary: false })).toBe("unknown");
  });

  it("reports anything else as unknown", () => {
    expect(topologyFromHello({})).toBe("unknown");
  });
});
