/**
 * Tests for the REST client against a local HTTP server that answers like the API
 * server: paths, verbs, content types, pagination, errors, watch streams and logs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KubeApiError, RESOURCES, type WatchEvent } from "./client.ts";
import type { ConfigMap } from "./objects.ts";
import { RestKubeClient, resourcePath } from "./rest-client.ts";

/** One request as the server saw it. */
interface SeenRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  authorization: string | undefined;
  body: string;
}

const seen: SeenRequest[] = [];
let server: Server;
let client: RestKubeClient;

/** The fake API server's routes. */
function route(request: IncomingMessage, body: string, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const json = (status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };
  const path = url.pathname;

  if (path === "/api/v1/namespaces/prod/configmaps/present" && request.method === "GET") {
    json(200, { metadata: { name: "present" } });
  } else if (path === "/api/v1/namespaces/prod/configmaps/missing") {
    json(404, {
      kind: "Status",
      reason: "NotFound",
      message: 'configmaps "missing" not found',
      code: 404,
    });
  } else if (
    path === "/api/v1/namespaces/prod/configmaps" &&
    request.method === "GET" &&
    url.searchParams.get("watch") === "true"
  ) {
    // A watch: two events, a bookmark, then the server ends the stream.
    response.writeHead(200, { "content-type": "application/json" });
    const events = [
      { type: "ADDED", object: { metadata: { name: "a", resourceVersion: "11" } } },
      { type: "BOOKMARK", object: { metadata: { resourceVersion: "12" } } },
      { type: "ERROR", object: { code: 410, message: "too old" } },
    ];
    response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n\n`);
  } else if (path === "/api/v1/namespaces/prod/configmaps" && request.method === "GET") {
    // Two pages.
    if (url.searchParams.get("continue") === "page-2") {
      json(200, { metadata: { resourceVersion: "10" }, items: [{ metadata: { name: "b" } }] });
    } else {
      json(200, {
        metadata: { resourceVersion: "9", continue: "page-2" },
        items: [{ metadata: { name: "a" } }],
      });
    }
  } else if (path === "/apis/batch/v1/jobs" && request.method === "GET") {
    json(200, { metadata: { resourceVersion: "1" } });
  } else if (path === "/api/v1/namespaces/prod/configmaps" && request.method === "POST") {
    json(201, JSON.parse(body));
  } else if (path === "/api/v1/namespaces/prod/configmaps/a" && request.method === "PUT") {
    json(409, { reason: "Conflict", message: "the object has been modified" });
  } else if (path === "/apis/mongoshield.io/v1alpha1/namespaces/prod/mongoshieldbackups/b/status") {
    json(200, { metadata: { name: "b" }, status: JSON.parse(body).status });
  } else if (path === "/api/v1/namespaces/prod/configmaps/gone" && request.method === "DELETE") {
    json(404, { reason: "NotFound", message: "gone" });
  } else if (path === "/api/v1/namespaces/prod/configmaps/a" && request.method === "DELETE") {
    json(200, { kind: "Status", status: "Success" });
  } else if (path === "/api/v1/namespaces/prod/pods/p/log") {
    response.writeHead(200, { "content-type": "text/plain" }).end("line 1\nline 2\n");
  } else if (path === "/api/v1/namespaces/prod/configmaps/html") {
    response.writeHead(502, { "content-type": "text/html" }).end("<html>bad gateway</html>");
  } else if (path === "/api/v1/namespaces/prod/configmaps/empty") {
    response.writeHead(500).end();
  } else {
    json(500, { reason: "Unexpected", message: `no route for ${request.method} ${path}` });
  }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body,
      });
      route(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: "test", server: `http://127.0.0.1:${port}/`, skipTLSVerify: true }],
    users: [{ name: "test", token: "secret-token" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  client = new RestKubeClient(config);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("resourcePath", () => {
  it("builds core, group, namespaced, cluster-wide and subresource paths", () => {
    expect(resourcePath(RESOURCES.pods, "prod", "p", "log")).toBe(
      "/api/v1/namespaces/prod/pods/p/log",
    );
    expect(resourcePath(RESOURCES.jobs, undefined)).toBe("/apis/batch/v1/jobs");
    expect(resourcePath(RESOURCES.plans, "a b", "x/y")).toBe(
      "/apis/mongoshield.io/v1alpha1/namespaces/a%20b/mongoshieldbackupplans/x%2Fy",
    );
  });
});

describe("RestKubeClient", () => {
  it("refuses a kubeconfig without a current cluster", () => {
    expect(() => new RestKubeClient(new KubeConfig())).toThrow("no current cluster");
  });

  it("gets objects with the bearer token, and undefined for 404", async () => {
    expect(await client.get<ConfigMap>(RESOURCES.configMaps, "prod", "present")).toEqual({
      metadata: { name: "present" },
    });
    expect(await client.get(RESOURCES.configMaps, "prod", "missing")).toBeUndefined();
    expect(seen.at(-1)?.authorization).toBe("Bearer secret-token");
  });

  it("pages through lists and fills in apiVersion and kind", async () => {
    const list = await client.list<ConfigMap>(RESOURCES.configMaps, "prod", {
      labelSelector: "a=b",
    });
    expect(list.resourceVersion).toBe("10");
    expect(list.items).toEqual([
      { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "a" } },
      { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "b" } },
    ]);
    expect(seen.at(-1)?.url).toContain("labelSelector=a%3Db");
    expect(seen.at(-1)?.url).toContain("continue=page-2");
    expect(await client.list(RESOURCES.jobs, undefined)).toEqual({
      items: [],
      resourceVersion: "1",
    });
  });

  it("creates, and reports conflicts as KubeApiError", async () => {
    const created = await client.create<ConfigMap>(RESOURCES.configMaps, "prod", {
      metadata: { name: "a" },
    });
    expect(created.metadata.name).toBe("a");
    expect(seen.at(-1)?.contentType).toBe("application/json");

    const error = await client
      .replace(RESOURCES.configMaps, "prod", { metadata: { name: "a", resourceVersion: "1" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KubeApiError);
    expect(error).toMatchObject({
      statusCode: 409,
      reason: "Conflict",
      message: "the object has been modified",
    });
  });

  it("merge-patches the status subresource", async () => {
    const patched = await client.mergePatch(
      RESOURCES.backups,
      "prod",
      "b",
      { status: { phase: "Running" } },
      "status",
    );
    expect(patched).toEqual({ metadata: { name: "b" }, status: { phase: "Running" } });
    expect(seen.at(-1)).toMatchObject({
      method: "PATCH",
      contentType: "application/merge-patch+json",
    });
  });

  it("deletes with a propagation policy, quietly when already gone", async () => {
    await client.delete(RESOURCES.configMaps, "prod", "a", "Foreground");
    expect(JSON.parse(seen.at(-1)?.body ?? "{}")).toMatchObject({
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
    });
    await expect(client.delete(RESOURCES.configMaps, "prod", "gone")).resolves.toBeUndefined();
    expect(JSON.parse(seen.at(-1)?.body ?? "{}").propagationPolicy).toBe("Background");
  });

  it("streams watch events until the server ends the stream", async () => {
    const events: WatchEvent<ConfigMap>[] = [];
    await client.watch<ConfigMap>(
      RESOURCES.configMaps,
      "prod",
      {
        resourceVersion: "10",
        labelSelector: "x=y",
        timeoutSeconds: 5,
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    );
    expect(events.map((event) => event.type)).toEqual(["ADDED", "BOOKMARK", "ERROR"]);
    expect(events[0]?.object).toMatchObject({ apiVersion: "v1", kind: "ConfigMap" });
    const url = seen.at(-1)?.url ?? "";
    expect(url).toContain("watch=true");
    expect(url).toContain("resourceVersion=10");
    expect(url).toContain("allowWatchBookmarks=true");
    expect(url).toContain("timeoutSeconds=5");
  });

  it("ends a watch quietly when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.watch(
        RESOURCES.configMaps,
        "prod",
        { resourceVersion: "1", signal: controller.signal },
        () => {},
      ),
    ).resolves.toBeUndefined();
  });

  it("reads pod logs with tail and byte limits", async () => {
    const log = await client.podLogs("prod", "p", {
      container: "mongoshield",
      tailLines: 100,
      limitBytes: 1000,
    });
    expect(log).toBe("line 1\nline 2\n");
    expect(seen.at(-1)?.url).toContain("container=mongoshield&tailLines=100&limitBytes=1000");
  });

  it("keeps the raw text of non-JSON error responses", async () => {
    await expect(client.get(RESOURCES.configMaps, "prod", "html")).rejects.toMatchObject({
      statusCode: 502,
      reason: "Unknown",
      message: "<html>bad gateway</html>",
    });
    await expect(client.get(RESOURCES.configMaps, "prod", "empty")).rejects.toMatchObject({
      message: "HTTP 500",
    });
  });
});
