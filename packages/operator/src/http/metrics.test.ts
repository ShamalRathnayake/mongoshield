/** Tests for the Prometheus registry and text format. */

import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, Registry, renderLabels } from "./metrics.ts";

describe("metrics", () => {
  it("renders counters, gauges and histograms in the text format", () => {
    const registry = new Registry();
    const counter = registry.add(new Counter("runs_total", "Runs."));
    const gauge = registry.add(new Gauge("depth", "Depth."));
    const histogram = registry.add(new Histogram("duration_seconds", "Duration.", [1, 0.5]));
    counter.inc({ result: "ok" });
    counter.inc({ result: "ok" }, 2);
    gauge.set({}, 4);
    histogram.observe({ controller: "plan" }, 0.2);
    histogram.observe({ controller: "plan" }, 3);

    expect(registry.render()).toBe(
      [
        "# HELP runs_total Runs.",
        "# TYPE runs_total counter",
        'runs_total{result="ok"} 3',
        "# HELP depth Depth.",
        "# TYPE depth gauge",
        "depth 4",
        "# HELP duration_seconds Duration.",
        "# TYPE duration_seconds histogram",
        'duration_seconds_bucket{controller="plan",le="0.5"} 1',
        'duration_seconds_bucket{controller="plan",le="1"} 1',
        'duration_seconds_bucket{controller="plan",le="+Inf"} 2',
        'duration_seconds_sum{controller="plan"} 3.2',
        'duration_seconds_count{controller="plan"} 2',
        "",
      ].join("\n"),
    );
    expect(counter.value({ result: "ok" })).toBe(3);
    expect(counter.value({ result: "missing" })).toBe(0);
    expect(gauge.value()).toBe(4);
    expect(histogram.count({ controller: "plan" })).toBe(2);
    expect(histogram.count({ controller: "other" })).toBe(0);
  });

  it("computes collected gauges at scrape time", () => {
    let value = 1;
    const gauge = new Gauge("live", "Live.", () => [{ labels: { plan: "a" }, value }]);
    expect(gauge.render()).toEqual(['live{plan="a"} 1']);
    value = 2;
    expect(gauge.value({ plan: "a" })).toBe(2);
    expect(gauge.value({ plan: "b" })).toBeUndefined();
  });

  it("escapes label values and formats special numbers", () => {
    expect(renderLabels({ path: 'a"b\\c\nd' })).toBe('{path="a\\"b\\\\c\\nd"}');
    const gauge = new Gauge("g", "G.");
    gauge.set({ k: "nan" }, Number.NaN);
    gauge.set({ k: "inf" }, Number.POSITIVE_INFINITY);
    gauge.set({ k: "-inf" }, Number.NEGATIVE_INFINITY);
    expect(gauge.render()).toEqual(['g{k="nan"} NaN', 'g{k="inf"} +Inf', 'g{k="-inf"} -Inf']);
  });

  it("refuses to register two families with the same name", () => {
    const registry = new Registry();
    registry.add(new Counter("x", "X."));
    expect(() => registry.add(new Gauge("x", "X."))).toThrow("already registered");
  });
});
