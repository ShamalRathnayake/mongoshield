/** Tests for the probe and metrics endpoint. */

import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startHttpServer, stopHttpServer } from "./server.ts";

describe("HTTP endpoint", () => {
  it("serves /healthz, /readyz and /metrics", async () => {
    let ready = false;
    const server = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      isReady: () => ready,
      metrics: () => "up 1\n",
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      ready = true;
      expect(await (await fetch(`${base}/readyz?verbose`)).text()).toBe("ok\n");
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.headers.get("content-type")).toContain("version=0.0.4");
      expect(await metrics.text()).toBe("up 1\n");
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(405);
    } finally {
      await stopHttpServer(server);
    }
  });

  it("listens on IPv4 and, where the machine has it, IPv6 by default", async () => {
    const server = await startHttpServer({ port: 0, isReady: () => true, metrics: () => "" });
    const address = server.address() as AddressInfo;
    try {
      // `::` is dual stack; on a machine without IPv6 the fallback is 0.0.0.0.
      expect(["::", "0.0.0.0"]).toContain(address.address);
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
      if (address.address === "::") {
        expect((await fetch(`http://[::1]:${address.port}/healthz`)).status).toBe(200);
      }
    } finally {
      await stopHttpServer(server);
    }
  });

  it("requires the bearer token for /metrics when one is set, but never for the probes", async () => {
    const server = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      isReady: () => true,
      metrics: () => 'mongoshield_backups{namespace="team-a"} 1\n',
      metricsToken: "s3cret-token",
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const anonymous = await fetch(`${base}/metrics`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
      expect(await anonymous.text()).not.toContain("team-a");
      const wrong = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer guess" },
      });
      expect(wrong.status).toBe(401);
      const right = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer s3cret-token" },
      });
      expect(right.status).toBe(200);
      expect(await right.text()).toContain("team-a");
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      await stopHttpServer(server);
    }
  });

  it("fails to start on a port in use", async () => {
    const first = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      isReady: () => true,
      metrics: () => "",
    });
    const { port } = first.address() as AddressInfo;
    try {
      await expect(
        startHttpServer({ port, host: "127.0.0.1", isReady: () => true, metrics: () => "" }),
      ).rejects.toThrow();
    } finally {
      await stopHttpServer(first);
    }
  });
});
