import { describe, expect, it, vi } from "vitest";
import { CANCELLING_MESSAGE, createInterruptHandler, SIGINT_EXIT_CODE } from "./interrupt.ts";

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
