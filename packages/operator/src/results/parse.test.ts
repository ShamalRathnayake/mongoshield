/** Tests for finding MongoShield's --json document in a pod log. */

import { describe, expect, it } from "vitest";
import { cliLog, successReport } from "../../test/helpers/fixtures.ts";
import { extractJsonDocuments, parseCommandOutput } from "./parse.ts";

describe("parseCommandOutput", () => {
  it("finds a run report among stderr lines", () => {
    const log = cliLog(successReport(), ["Connecting…", "{ not json", "Backing up 12 collections"]);
    const output = parseCommandOutput(`${log}warning: something after\n`);
    expect(output.kind).toBe("run");
    expect(output.kind === "run" && output.report.backup?.id).toBe("2026-10-24T11-59-02Z_ab12cd");
  });

  it("recognises restore results and error documents", () => {
    expect(
      parseCommandOutput(
        cliLog({
          plan: { backupId: "x", entries: [] },
          dryRun: true,
          documentsRestored: 0,
          durationMs: 1,
        }),
      ).kind,
    ).toBe("restore");
    const error = parseCommandOutput(
      cliLog({ error: { code: "MS_X", message: "m", hint: "h", exitCode: 3, docsUrl: "u" } }),
    );
    expect(error).toEqual({
      kind: "error",
      error: { code: "MS_X", message: "m", hint: "h", exitCode: 3 },
    });
    const bare = parseCommandOutput(cliLog({ error: { code: "MS_Y" } }));
    expect(bare).toEqual({ kind: "error", error: { code: "MS_Y", message: "" } });
  });

  it("takes the last recognisable document and ignores others", () => {
    const log = [
      cliLog({ unrelated: true }),
      cliLog(successReport("first")),
      cliLog(successReport("second")),
      cliLog([1, 2]),
    ].join("");
    const output = parseCommandOutput(log);
    expect(output.kind === "run" && output.report.backup?.id).toBe("second");
  });

  it("returns none for logs without a document, or with a truncated one", () => {
    expect(parseCommandOutput("just text\n")).toEqual({ kind: "none" });
    expect(parseCommandOutput('{\n  "runId": "x",\n')).toEqual({ kind: "none" });
    expect(parseCommandOutput('{\n  "runId": \n}\n')).toEqual({ kind: "none" });
    expect(parseCommandOutput(cliLog({ unrelated: true }))).toEqual({ kind: "none" });
  });

  it("handles Windows line endings", () => {
    expect(extractJsonDocuments('{\r\n  "a": 1\r\n}\r\n')).toEqual([{ a: 1 }]);
  });
});
