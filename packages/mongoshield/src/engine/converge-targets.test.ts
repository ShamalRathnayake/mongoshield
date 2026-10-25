import { describe, expect, it } from "vitest";
import { compileNamespaceFilter } from "../mongo/index.ts";
import { planReplayTargets } from "./converge-targets.ts";
import { compileRenameMap } from "./restore-rename.ts";

describe("planReplayTargets", () => {
  const summary = {
    events: 10,
    namespaces: new Set([
      "app.users",
      "app.orders",
      "app.fresh",
      "app.tmp.agg_out.1",
      "app.tmp.agg_out.2",
      "other.x",
    ]),
    renamedTo: new Map([
      ["app.tmp.agg_out.1", "app.orders"],
      ["app.tmp.agg_out.2", "app.excluded"],
    ]),
  };

  const targets = planReplayTargets({
    backedUp: new Set(["app.users", "app.orders"]),
    restored: new Map([
      ["app.users", "restored.users"],
      ["app.orders", "restored.orders"],
    ]),
    filter: compileNamespaceFilter({ include: ["app.*"], exclude: ["app.excluded"] }),
    rename: compileRenameMap({ "app.*": "restored.*" }),
    summary,
  });

  it("replays backed-up namespaces into their planned targets", () => {
    expect(targets.targetOf("app.users")).toBe("restored.users");
  });

  it("restores collections created during the window when the patterns select them", () => {
    expect(targets.targetOf("app.fresh")).toBe("restored.fresh");
    expect(targets.targetOf("other.x")).toBeUndefined();
    expect([...targets.windowTargets]).toEqual([["app.fresh", "restored.fresh"]]);
  });

  it("replays scratch collections next to the restored namespace they are renamed over", () => {
    expect(targets.targetOf("app.tmp.agg_out.1")).toBe("restored.tmp.agg_out.1");
    expect(targets.targetOf("app.tmp.agg_out.2")).toBeUndefined();
  });

  it("lists the sources of a database for dropDatabase", () => {
    expect([...targets.sourcesInDatabase("app")].sort()).toEqual([
      "app.fresh",
      "app.orders",
      "app.tmp.agg_out.1",
      "app.users",
    ]);
  });
});
