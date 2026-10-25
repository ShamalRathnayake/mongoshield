/**
 * Retention presets for the plan editor: common "how many backups to keep" policies
 * people pick from a select, instead of filling in five number boxes.
 *
 * A plan's retention is still the library's bucket counts (`last`, `daily`, `weekly`,
 * `monthly`, `yearly`). Each preset is a set of those counts; "Custom" shows the five
 * boxes. An existing plan whose counts match no preset opens as "Custom", so nothing
 * about it changes unless the user changes it.
 */

/** Retention buckets, in the order the library documents them. */
export const RETENTION_KEYS = ["last", "daily", "weekly", "monthly", "yearly"] as const;

/** One retention bucket. */
export type RetentionKey = (typeof RETENTION_KEYS)[number];

/** The retention counts as the form holds them: strings while typing, "" = not used. */
export type RetentionText = Readonly<Record<RetentionKey, string>>;

/** The preset choices, in the order the select lists them. */
export const RETENTION_PRESET_IDS = [
  "recommended",
  "last7",
  "last30",
  "forever",
  "custom",
] as const;

/** One retention choice. `custom` shows the five number boxes. */
export type RetentionPresetId = (typeof RETENTION_PRESET_IDS)[number];

/** A preset: its label, a sentence saying what it keeps, and its bucket counts. */
export interface RetentionPreset {
  readonly label: string;
  readonly description: string;
  readonly counts: Readonly<Partial<Record<RetentionKey, number>>>;
}

/** The presets (every choice except `custom`). */
export const RETENTION_PRESETS: Readonly<
  Record<Exclude<RetentionPresetId, "custom">, RetentionPreset>
> = {
  recommended: {
    label: "Daily for a week, weekly for a month, monthly for a year (recommended)",
    description:
      "Keeps the newest backup of each of the last 7 days, 4 weeks and 12 months: about 23 backups covering a year.",
    counts: { daily: 7, weekly: 4, monthly: 12 },
  },
  last7: {
    label: "Keep the last 7",
    description: "Keeps the 7 newest backups and deletes older ones.",
    counts: { last: 7 },
  },
  last30: {
    label: "Keep the last 30",
    description: "Keeps the 30 newest backups and deletes older ones.",
    counts: { last: 30 },
  },
  forever: {
    label: "Keep every backup (never delete)",
    description: "Nothing is deleted automatically; storage grows with every run.",
    counts: {},
  },
};

/** What "Custom" is called in the select. */
export const CUSTOM_RETENTION_LABEL = "Custom";

/** The form's text for a preset's counts: "7" in its buckets, "" in the rest. */
export function retentionTextFor(id: Exclude<RetentionPresetId, "custom">): RetentionText {
  const { counts } = RETENTION_PRESETS[id];
  return {
    last: counts.last === undefined ? "" : String(counts.last),
    daily: counts.daily === undefined ? "" : String(counts.daily),
    weekly: counts.weekly === undefined ? "" : String(counts.weekly),
    monthly: counts.monthly === undefined ? "" : String(counts.monthly),
    yearly: counts.yearly === undefined ? "" : String(counts.yearly),
  };
}

/**
 * The preset the form's counts match, or "custom". Blank buckets and "0" are not the
 * same thing to the library, so they are compared as typed (after trimming).
 */
export function retentionPresetOf(retention: RetentionText): RetentionPresetId {
  for (const id of RETENTION_PRESET_IDS) {
    if (id === "custom") continue;
    const preset = retentionTextFor(id);
    if (RETENTION_KEYS.every((key) => retention[key].trim() === preset[key])) return id;
  }
  return "custom";
}
