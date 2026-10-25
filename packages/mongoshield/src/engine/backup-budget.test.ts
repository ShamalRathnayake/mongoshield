import { describe, expect, it } from "vitest";
import { TimeBudget } from "./backup-budget.ts";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 0;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe("TimeBudget", () => {
  it("always starts the first part, even with no time at all", () => {
    const clock = fakeClock();
    const budget = new TimeBudget(1, { startedAt: 0, now: clock.now });
    clock.advance(100);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(false);
    expect(budget.exhausted).toBe(true);
  });

  it("stops starting parts that would not finish before the deadline", () => {
    const clock = fakeClock();
    // 100 s budget: the reserve is 5 s.
    const budget = new TimeBudget(100_000, { startedAt: 0, now: clock.now });
    expect(budget.tryStart()).toBe(true);
    clock.advance(30_000);
    budget.partFinished(30_000);
    expect(budget.tryStart()).toBe(true); // 30 s + 30 s + 5 s ≤ 100 s
    clock.advance(40_000);
    budget.partFinished(40_000);
    expect(budget.tryStart()).toBe(false); // 70 s + 35 s (average) + 5 s > 100 s
  });

  it("stays exhausted once a part was refused", () => {
    const clock = fakeClock();
    const budget = new TimeBudget(1000, { startedAt: 0, now: clock.now });
    budget.tryStart();
    clock.advance(2000);
    expect(budget.tryStart()).toBe(false);
    clock.advance(-2000);
    expect(budget.tryStart()).toBe(false);
  });
});
