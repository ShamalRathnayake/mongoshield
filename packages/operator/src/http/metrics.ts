/**
 * A small Prometheus metrics registry: counters, gauges and histograms with labels,
 * rendered in the Prometheus text exposition format (version 0.0.4).
 *
 * Hand-rolled rather than pulling in prom-client: the operator needs a dozen series,
 * and the text format is simple and stable:
 *
 *   # HELP mongoshield_operator_reconcile_total Reconciliations by controller and result.
 *   # TYPE mongoshield_operator_reconcile_total counter
 *   mongoshield_operator_reconcile_total{controller="backup",result="success"} 42
 *
 * Gauges can also be computed when scraped (`collect`), which is how per-plan backup
 * metrics are read straight from the informer caches.
 */

/** Label names and values of one series. */
export type Labels = Readonly<Record<string, string>>;

/** One metric family (all series sharing a name). */
interface Family {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  render(): string[];
}

/** Escapes a label value: backslash, double quote and newline must be escaped. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Renders `{a="1",b="2"}` (or nothing for no labels), keys sorted for stable output. */
export function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

/** Prometheus number formatting: integers as-is, special values by name. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** A monotonically increasing count, per label set. */
export class Counter implements Family {
  readonly type = "counter";
  readonly #values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  /** Adds `amount` (default 1) to the series with these labels. */
  inc(labels: Labels = {}, amount = 1): void {
    const key = renderLabels(labels);
    const entry = this.#values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.#values.set(key, entry);
  }

  /** The current value of one series (for tests). */
  value(labels: Labels = {}): number {
    return this.#values.get(renderLabels(labels))?.value ?? 0;
  }

  render(): string[] {
    return [...this.#values.values()].map(
      (entry) => `${this.name}${renderLabels(entry.labels)} ${formatValue(entry.value)}`,
    );
  }
}

/** A value that goes up and down, set directly or computed at scrape time. */
export class Gauge implements Family {
  readonly type = "gauge";
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  readonly #collect: (() => readonly { labels: Labels; value: number }[]) | undefined;

  constructor(
    readonly name: string,
    readonly help: string,
    /** When given, the series are whatever this returns at scrape time. */
    collect?: () => readonly { labels: Labels; value: number }[],
  ) {
    this.#collect = collect;
  }

  set(labels: Labels, value: number): void {
    this.#values.set(renderLabels(labels), { labels, value });
  }

  /** The current value of one series (for tests). */
  value(labels: Labels = {}): number | undefined {
    if (this.#collect) {
      const key = renderLabels(labels);
      return this.#collect().find((entry) => renderLabels(entry.labels) === key)?.value;
    }
    return this.#values.get(renderLabels(labels))?.value;
  }

  render(): string[] {
    const entries = this.#collect ? this.#collect() : [...this.#values.values()];
    return entries.map(
      (entry) => `${this.name}${renderLabels(entry.labels)} ${formatValue(entry.value)}`,
    );
  }
}

/** Observations counted into cumulative buckets, plus their sum and count. */
export class Histogram implements Family {
  readonly type = "histogram";
  readonly #buckets: readonly number[];
  readonly #series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    /** Upper bounds, ascending. A +Inf bucket is always added. */
    buckets: readonly number[],
  ) {
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = renderLabels(labels);
    const series = this.#series.get(key) ?? {
      labels,
      counts: this.#buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.#buckets.forEach((bound, index) => {
      if (value <= bound) series.counts[index] = (series.counts[index] ?? 0) + 1;
    });
    series.sum += value;
    series.count += 1;
    this.#series.set(key, series);
  }

  /** How many observations a series has (for tests). */
  count(labels: Labels = {}): number {
    return this.#series.get(renderLabels(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines: string[] = [];
    for (const series of this.#series.values()) {
      this.#buckets.forEach((bound, index) => {
        const labels = renderLabels({ ...series.labels, le: formatValue(bound) });
        lines.push(`${this.name}_bucket${labels} ${series.counts[index] ?? 0}`);
      });
      lines.push(
        `${this.name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
      );
      lines.push(`${this.name}_sum${renderLabels(series.labels)} ${formatValue(series.sum)}`);
      lines.push(`${this.name}_count${renderLabels(series.labels)} ${series.count}`);
    }
    return lines;
  }
}

/** A set of metric families rendered together on /metrics. */
export class Registry {
  readonly #families: Family[] = [];

  /** Adds a family and returns it, so registration reads `const x = registry.add(new Counter(…))`. */
  add<T extends Family>(family: T): T {
    if (this.#families.some((existing) => existing.name === family.name)) {
      throw new Error(`metric ${family.name} is already registered`);
    }
    this.#families.push(family);
    return family;
  }

  /** The text exposition of every family. */
  render(): string {
    const lines: string[] = [];
    for (const family of this.#families) {
      lines.push(`# HELP ${family.name} ${family.help}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);
      lines.push(...family.render());
    }
    return `${lines.join("\n")}\n`;
  }
}
