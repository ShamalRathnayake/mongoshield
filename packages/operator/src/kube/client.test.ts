/** Tests for the client helpers. */

import { describe, expect, it } from "vitest";
import {
  apiVersionOf,
  isAlreadyExists,
  isConflict,
  isNotFound,
  KubeApiError,
  RESOURCES,
} from "./client.ts";

describe("client helpers", () => {
  it("builds apiVersion strings", () => {
    expect(apiVersionOf(RESOURCES.pods)).toBe("v1");
    expect(apiVersionOf(RESOURCES.jobs)).toBe("batch/v1");
    expect(apiVersionOf(RESOURCES.plans)).toBe("mongoshield.io/v1alpha1");
  });

  it("classifies API errors", () => {
    expect(isNotFound(new KubeApiError(404, "NotFound", "x"))).toBe(true);
    expect(isNotFound(new Error("x"))).toBe(false);
    expect(isConflict(new KubeApiError(409, "Conflict", "x"))).toBe(true);
    expect(isAlreadyExists(new KubeApiError(409, "Conflict", "x"))).toBe(false);
    expect(isAlreadyExists(new KubeApiError(409, "AlreadyExists", "x"))).toBe(true);
    expect(new KubeApiError(500, "InternalError", "boom").name).toBe("KubeApiError");
  });
});
