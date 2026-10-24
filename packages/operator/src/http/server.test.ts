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
