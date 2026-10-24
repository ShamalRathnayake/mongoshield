/**
 * A small validator for the subset of OpenAPI v3 the CRDs use, so tests can check
 * that example objects (the ones in the docs and fixtures) are accepted by the CRD
 * schemas, and that bad ones are refused. CEL rules are not evaluated here; the e2e
 * test runs them on a real API server.
 */

import type { JsonSchema } from "../../src/api/crds.ts";

/** Returns the problems found (empty when `value` is valid). */
export function validateAgainst(schema: JsonSchema, value: unknown, path = ""): string[] {
  if (schema["x-kubernetes-int-or-string"]) {
    return typeof value === "string" || Number.isInteger(value)
      ? []
      : [`${path}: not an int-or-string`];
  }
  switch (schema.type) {
    case "string":
      return validateString(schema, value, path);
    case "integer":
      return Number.isInteger(value)
        ? validateNumber(schema, value as number, path)
        : [`${path}: not an integer`];
    case "number":
      return typeof value === "number"
        ? validateNumber(schema, value, path)
        : [`${path}: not a number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: not a boolean`];
    case "array":
      return validateArray(schema, value, path);
    case "object":
      return validateObject(schema, value, path);
    default:
      return [];
  }
}

function validateString(schema: JsonSchema, value: unknown, path: string): string[] {
  if (typeof value !== "string") return [`${path}: not a string`];
  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value))
    problems.push(`${path}: "${value}" not in ${schema.enum.join("|")}`);
  if (schema.minLength !== undefined && value.length < schema.minLength)
    problems.push(`${path}: too short`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength)
    problems.push(`${path}: too long`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value))
    problems.push(`${path}: does not match ${schema.pattern}`);
  return problems;
}

function validateNumber(schema: JsonSchema, value: number, path: string): string[] {
  const problems: string[] = [];
  if (schema.minimum !== undefined && value < schema.minimum)
    problems.push(`${path}: below ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum)
    problems.push(`${path}: above ${schema.maximum}`);
  return problems;
}

function validateArray(schema: JsonSchema, value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path}: not an array`];
  const problems: string[] = [];
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    problems.push(`${path}: too many items`);
  value.forEach((item, index) => {
    if (schema.items) problems.push(...validateAgainst(schema.items, item, `${path}[${index}]`));
  });
  return problems;
}

function validateObject(schema: JsonSchema, value: unknown, path: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [`${path}: not an object`];
  if (schema["x-kubernetes-preserve-unknown-fields"]) return [];
  // `metadata: { type: object }`: validated by the API server itself, not the CRD schema.
  if (!schema.properties && !schema.additionalProperties) return [];
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const required of schema.required ?? []) {
    if (record[required] === undefined) problems.push(`${path}.${required}: required`);
  }
  for (const [key, child] of Object.entries(record)) {
    const childSchema = schema.properties?.[key] ?? schema.additionalProperties;
    if (!childSchema) {
      problems.push(`${path}.${key}: unknown field`);
      continue;
    }
    problems.push(...validateAgainst(childSchema, child, `${path}.${key}`));
  }
  return problems;
}
