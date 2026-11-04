/**
 * Tests for the container help: the quick fill offers host.docker.internal only where it
 * resolves (and with directConnection=true), keeps localhost in Kubernetes and with host
 * networking, uses Podman's name under Podman, and on Linux Docker Engine without
 * --add-host explains how to create the name instead of offering it.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerEnvironment } from "../../shared/api.ts";
import { connectionStringSuggestions, LocalhostHint } from "./container-host.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

const DESKTOP: ContainerEnvironment = {
  kind: "docker-desktop",
  hostAlias: "host.docker.internal",
  hostAliasResolves: true,
};
const ENGINE_WITHOUT_ADD_HOST: ContainerEnvironment = {
  kind: "docker-engine",
  hostAlias: "host.docker.internal",
  hostAliasResolves: false,
};
const PODMAN: ContainerEnvironment = {
  kind: "podman",
  hostAlias: "host.containers.internal",
  hostAliasResolves: true,
};

/** The values the quick fill offers in an environment. */
function values(container: ContainerEnvironment | undefined): string[] {
  return connectionStringSuggestions(container).map((suggestion) => suggestion.value);
}

describe("connectionStringSuggestions", () => {
  it("offers host.docker.internal with directConnection where it resolves, not localhost", () => {
    expect(values(DESKTOP)).toContain(
      "mongodb://host.docker.internal:27017/?directConnection=true",
    );
    expect(values(DESKTOP)).not.toContain("mongodb://localhost:27017");
  });

  it("offers neither where host.docker.internal does not resolve (Linux without --add-host)", () => {
    expect(values(ENGINE_WITHOUT_ADD_HOST).some((value) => value.includes("host.docker"))).toBe(
      false,
    );
    expect(values(ENGINE_WITHOUT_ADD_HOST)).not.toContain("mongodb://localhost:27017");
    // ...nor before the server's lookup has answered.
    const unknown = { kind: "docker-engine", hostAlias: "host.docker.internal" } as const;
    expect(values(unknown).some((value) => value.includes("host.docker"))).toBe(false);
  });

  it("uses host.containers.internal under Podman", () => {
    expect(values(PODMAN)).toContain(
      "mongodb://host.containers.internal:27017/?directConnection=true",
    );
  });

  it("keeps localhost in Kubernetes, with host networking and outside containers", () => {
    for (const container of [
      { kind: "kubernetes" },
      { kind: "host-network" },
      { kind: "none" },
      undefined,
    ] as const) {
      expect(values(container), container?.kind).toContain("mongodb://localhost:27017");
      expect(values(container).some((value) => value.includes("host.docker"))).toBe(false);
    }
  });
});

describe("LocalhostHint", () => {
  it("offers the host alias in one click where it resolves", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(<LocalhostHint uri="mongodb://localhost:27017" container={DESKTOP} onUse={onUse} />);
    await user.click(screen.getByRole("button", { name: "Use host.docker.internal" }));
    expect(onUse).toHaveBeenCalledWith(
      "mongodb://host.docker.internal:27017/?directConnection=true",
    );
  });

  it("explains --add-host instead where the alias does not resolve", () => {
    for (const uri of ["", "mongodb://localhost:27017", "mongodb://host.docker.internal:27017"]) {
      render(<LocalhostHint uri={uri} container={ENGINE_WITHOUT_ADD_HOST} onUse={() => {}} />);
      expect(
        screen.getByText("host.docker.internal does not exist in this container"),
      ).toBeTruthy();
      expect(screen.getByText("--add-host=host.docker.internal:host-gateway")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Use host/ })).toBeNull();
      cleanup();
    }
    // A string for another server needs no such help.
    render(
      <LocalhostHint
        uri="mongodb://db.example.com:27017"
        container={ENGINE_WITHOUT_ADD_HOST}
        onUse={() => {}}
      />,
    );
    expect(screen.queryByText(/does not exist in this container/)).toBeNull();
  });

  it("says nothing where localhost means what it says", () => {
    for (const container of [
      { kind: "kubernetes" },
      { kind: "host-network" },
      undefined,
    ] as const) {
      const { container: rendered } = render(
        <LocalhostHint uri="mongodb://localhost:27017" container={container} onUse={() => {}} />,
      );
      expect(rendered.textContent, container?.kind).toBe("");
      cleanup();
    }
  });
});
