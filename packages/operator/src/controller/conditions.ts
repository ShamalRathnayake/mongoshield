/**
 * Status conditions, following the Kubernetes API conventions:
 *
 *   - one entry per `type`, updated in place,
 *   - `lastTransitionTime` changes only when `status` flips (True/False/Unknown), so
 *     it answers "since when has this been failing?",
 *   - `observedGeneration` records which spec the condition describes.
 */

import type { Condition } from "../kube/objects.ts";

/** What a reconciler says about one condition. */
export interface ConditionInput {
  readonly type: string;
  readonly status: Condition["status"];
  readonly reason: string;
  readonly message: string;
}

/**
 * Returns `conditions` with `input` set: a new entry, or the existing one updated.
 * The transition time is kept when the status did not change.
 */
export function setCondition(
  conditions: readonly Condition[] | undefined,
  input: ConditionInput,
  generation: number | undefined,
  now: Date,
): Condition[] {
  const result: Condition[] = [];
  let found = false;
  for (const existing of conditions ?? []) {
    if (existing.type !== input.type) {
      result.push(existing);
      continue;
    }
    found = true;
    result.push(
      buildCondition(
        input,
        generation,
        existing.status === input.status ? existing.lastTransitionTime : now.toISOString(),
      ),
    );
  }
  if (!found) result.push(buildCondition(input, generation, now.toISOString()));
  return result;
}

/** Sets several conditions at once (same rules as `setCondition`). */
export function setConditions(
  conditions: readonly Condition[] | undefined,
  inputs: readonly ConditionInput[],
  generation: number | undefined,
  now: Date,
): Condition[] {
  let result = [...(conditions ?? [])];
  for (const input of inputs) result = setCondition(result, input, generation, now);
  return result;
}

/** The condition of a type, if present. */
export function findCondition(
  conditions: readonly Condition[] | undefined,
  type: string,
): Condition | undefined {
  return conditions?.find((condition) => condition.type === type);
}

/** True when the condition of that type exists with status "True". */
export function isConditionTrue(
  conditions: readonly Condition[] | undefined,
  type: string,
): boolean {
  return findCondition(conditions, type)?.status === "True";
}

function buildCondition(
  input: ConditionInput,
  generation: number | undefined,
  lastTransitionTime: string,
): Condition {
  return {
    type: input.type,
    status: input.status,
    reason: input.reason,
    // The API server caps messages at 32 KiB; logs tails can be longer.
    message: input.message.slice(0, 32_000),
    lastTransitionTime,
    ...(generation === undefined ? {} : { observedGeneration: generation }),
  };
}
