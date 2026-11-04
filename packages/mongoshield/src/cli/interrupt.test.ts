import { describe, expect, it, vi } from "vitest";
import {
  CANCELLING_MESSAGE,
  cliHandlesTermination,
  createInterruptHandler,
  SIGINT_EXIT_CODE,
} from "./interrupt.ts";

describe("cliHandlesTermination", () => {
  it("leaves SIGTERM to run and schedule, wherever global flags put them", () => {
    expect(cliHandlesTermination(["schedule"])).toBe(false);
    expect(cliHandlesTermination(["--config", "f.ts", "schedule"])).toBe(false);
    expect(cliHandlesTermination(["-c", "f.ts", "--verbose", "run", "--once"])).toBe(false);
    expect(cliHandlesTermination(["--config=f.ts", "run"])).toBe(false);
  });

  it("handles SIGTERM like Ctrl-C for every other command", () => {
    expect(cliHandlesTermination(["backup"])).toBe(true);
    expect(cliHandlesTermination(["--json", "list"])).toBe(true);
    expect(cliHandlesTermination([])).toBe(true);
    // A config file named like a command is a flag value, not the command.
    expect(cliHandlesTermination(["--config", "run", "backup"])).toBe(true);
  });
});

function setup() {
  const effects = { abort: vi.fn(), exit: vi.fn(), write: vi.fn() };
  return { effects, onInterrupt: createInterruptHandler(effects) };
}

describe("createInterruptHandler", () => {
  it("cancels the running operation on the first press, without exiting", () => {
    const { effects, onInterrupt } = setup();
    onInterrupt();
    expect(effects.write).toHaveBeenCalledWith(CANCELLING_MESSAGE);
    expect(effects.abort).toHaveBeenCalledTimes(1);
    expect(effects.exit).not.toHaveBeenCalled();
  });

  it("exits at once with 130 on the second press, without aborting again", () => {
    const { effects, onInterrupt } = setup();
    onInterrupt();
    onInterrupt();
    expect(effects.exit).toHaveBeenCalledWith(SIGINT_EXIT_CODE);
    expect(SIGINT_EXIT_CODE).toBe(130);
    expect(effects.abort).toHaveBeenCalledTimes(1);
    expect(effects.write).toHaveBeenCalledTimes(1);
  });

  it("keeps exiting on every later press", () => {
    const { effects, onInterrupt } = setup();
    onInterrupt();
    onInterrupt();
    onInterrupt();
    expect(effects.exit).toHaveBeenCalledTimes(2);
  });

  it("keeps a separate count per handler", () => {
    const first = setup();
    const second = setup();
    first.onInterrupt();
    second.onInterrupt();
    expect(first.effects.exit).not.toHaveBeenCalled();
    expect(second.effects.exit).not.toHaveBeenCalled();
  });
});
