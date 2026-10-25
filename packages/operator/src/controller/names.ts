/**
 * Names for the objects the operator creates.
 *
 * Kubernetes limits names and label values to 63 characters in many places (a Job's
 * name ends up in its pods' `job-name` label, so it must fit), and a CronJob's name
 * must leave room for the 11 characters the CronJob controller appends to the Jobs it
 * creates. Long names are therefore shortened, with a short hash of the full name at
 * the end, so two long names that share a prefix still get different results.
 */

import { createHash } from "node:crypto";

/** Max length of a label value and of most names used as labels. */
export const LABEL_VALUE_MAX = 63;

/** Max length of a CronJob name: 63 minus the "-" + 10-digit suffix of its Jobs. */
export const CRONJOB_NAME_MAX = 52;

/** Shortens `name` to `maxLength` characters, keeping it unique with a hash suffix. */
export function boundedName(name: string, maxLength = LABEL_VALUE_MAX): string {
  if (name.length <= maxLength) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  // Names must end with an alphanumeric character, so trim any trailing "-" or ".".
  const prefix = name.slice(0, maxLength - hash.length - 1).replace(/[-.]+$/, "");
  return `${prefix}-${hash}`;
}

/** A value that fits in a label (same shortening as names). */
export function labelValue(value: string): string {
  return boundedName(value, LABEL_VALUE_MAX);
}
