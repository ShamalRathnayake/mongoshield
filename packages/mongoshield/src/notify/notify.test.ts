/**
 * Notifiers against a real local HTTP server: what is sent, how it is signed,
 * retried and timed out, and that nothing ever throws.
 */

import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import type { RunReport } from "../schedule/report.ts";
import {
  discordPayload,
  heartbeatUrl,
  notifyRun,
  pingHeartbeat,
  sendHttp,
  sendWebhook,
  signWebhook,
  slackPayload,
  webhookPayload,
} from "./index.ts";

/** One request the test server received. */
interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
/** Status codes to answer with, in order; 200 once exhausted. */
let script: number[] = [];
/** Milliseconds to wait before answering. */
let delayMs = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      setTimeout(() => {
        response.statusCode = script.shift() ?? 200;
        response.end("ok");
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  script = [];
  delayMs = 0;
});

const FAST = { retryDelayMs: 1, timeoutMs: 2000 };

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    runId: "abc123",
    status: "success",
    startedAt: "2026-10-20T03:00:00.000Z",
    finishedAt: "2026-10-20T03:01:00.000Z",
    durationMs: 60_000,
    host: "worker-1",
    storage: "s3://acme/prod/",
    lock: { kind: "storage" },
    backup: {
      id: "2026-10-20T03-00-00Z_abcdef",
      namespaces: 3,
      documents: 1234,
      bytesRaw: 4096,
      bytesStored: 1024,
      durationMs: 59_000,
      attempts: 1,
    },
    ...overrides,
  };
}

const FAILURE = report({
  status: "failure",
  error: {
    step: "backup",
    code: "MS_CONNECTION_FAILED",
    message: "Could not connect to mongodb://app:***@db",
    hint: "Check the network.",
  },
});

function spyLogger() {
  return {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

describe("sendWebhook", () => {
  it("posts the documented JSON body with the event header", async () => {
    expect(await sendWebhook(`${baseUrl}/hook`, FAILURE, FAST)).toBe(true);
    const [request] = received;
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["x-mongoshield-event"]).toBe("backup.failure");
    expect(request?.headers["x-mongoshield-signature"]).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toEqual({ event: "backup.failure", report: FAILURE });
  });

  it("signs the body with HMAC-SHA256 over timestamp.body when a secret is set", async () => {
    await sendWebhook(`${baseUrl}/hook`, report(), {
      ...FAST,
      secret: "s3cret",
      timestamp: 1_792_555_204,
    });
    const [request] = received;
    const expected = createHmac("sha256", "s3cret")
      .update(`1792555204.${request?.body ?? ""}`)
      .digest("hex");
    expect(request?.headers["x-mongoshield-timestamp"]).toBe("1792555204");
    expect(request?.headers["x-mongoshield-signature"]).toBe(`sha256=${expected}`);
    expect(signWebhook(request?.body ?? "", "s3cret", 1_792_555_204)).toBe(`sha256=${expected}`);
  });

  it("retries once after a server error", async () => {
    script = [503];
    expect(await sendWebhook(`${baseUrl}/hook`, report(), FAST)).toBe(true);
    expect(received).toHaveLength(2);
  });

  it("does not retry a client error, and never throws", async () => {
    script = [404, 404];
    const logger = spyLogger();
    expect(await sendWebhook(`${baseUrl}/hook`, report(), { ...FAST, logger })).toBe(false);
    expect(received).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("gives up after a timeout and a retry, logging only the host", async () => {
    delayMs = 300;
    const logger = spyLogger();
    const secretUrl = `${baseUrl}/T000/B000/very-secret-token`;
    const delivered = await sendWebhook(secretUrl, report(), {
      retryDelayMs: 1,
      timeoutMs: 50,
      logger,
    });
    expect(delivered).toBe(false);
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.debug.mock.calls]);
    expect(logged).not.toContain("very-secret-token");
    expect(logged).toContain("127.0.0.1");
  });

  it("returns false for an unreachable host instead of throwing", async () => {
    expect(await sendWebhook("http://127.0.0.1:1/hook", report(), FAST)).toBe(false);
  });
});

describe("chat payloads", () => {
  it("builds Slack blocks with a fallback text and the error details", () => {
    const payload = slackPayload(FAILURE);
    expect(payload.text).toContain("FAILED");
    const text = JSON.stringify(payload.blocks);
    expect(text).toContain("MS_CONNECTION_FAILED");
    expect(text).toContain("Check the network.");
    expect(text).toContain("worker-1");
  });

  it("builds a Discord embed colored by outcome, with mentions disabled", () => {
    const success = discordPayload(report());
    const failure = discordPayload(FAILURE);
    expect(success).toMatchObject({ allowed_mentions: { parse: [] } });
    const color = (payload: Record<string, unknown>) =>
      (payload.embeds as { color: number }[])[0]?.color;
    expect(color(success)).not.toBe(color(failure));
    expect(JSON.stringify(failure)).toContain("MS_CONNECTION_FAILED");
  });

  it("shows a scheduled drill's RTO in chat messages, and sends it in webhook bodies", () => {
    const drilled = report({
      verify: { mode: "drill", ok: true, problems: [], attempts: 1, rtoMs: 42_000 },
    });
    expect(JSON.stringify(slackPayload(drilled))).toContain("drill, RTO 42 s: ok");
    expect(JSON.stringify(discordPayload(drilled))).toContain("verified (drill, RTO 42 s)");
    expect(webhookPayload(drilled).report.verify?.rtoMs).toBe(42_000);
  });
});

describe("heartbeat", () => {
  it("pings the URL on success and /fail on failure (healthchecks.io convention)", () => {
    const base = "https://hc-ping.com/1234-abcd";
    expect(heartbeatUrl(base, "success")).toBe(base);
    expect(heartbeatUrl(base, "failure")).toBe(`${base}/fail`);
    expect(heartbeatUrl(`${base}/?rid=1`, "failure")).toBe(`${base}/fail?rid=1`);
  });

  it("uses Cronitor's state parameter for cronitor.link URLs", () => {
    const base = "https://cronitor.link/p/KEY/nightly-backup";
    expect(heartbeatUrl(base, "success")).toBe(`${base}?state=complete`);
    expect(heartbeatUrl(base, "failure")).toBe(`${base}?state=fail`);
  });

  it("sends a GET request", async () => {
    expect(await pingHeartbeat(`${baseUrl}/ping/uuid`, "failure", FAST)).toBe(true);
    expect(received[0]).toMatchObject({ method: "GET", path: "/ping/uuid/fail" });
  });
});

describe("notifyRun", () => {
  const targets = [
    { type: "webhook" as const, url: `PLACEHOLDER/all`, on: ["success", "failure"] as const },
    { type: "slack" as const, url: `PLACEHOLDER/slack` },
    { type: "discord" as const, url: `PLACEHOLDER/discord`, on: ["success"] as const },
  ];
  const withBase = () =>
    targets.map((target) => ({ ...target, url: target.url.replace("PLACEHOLDER", baseUrl) }));

  it("sends failures to targets that want them (failures only by default) and pings /fail", async () => {
    const outcome = await notifyRun(FAILURE, {
      ...FAST,
      targets: withBase(),
      heartbeat: `${baseUrl}/hb`,
    });
    expect(outcome.sent.map((sent) => sent.type).sort()).toEqual(["slack", "webhook"]);
    expect(outcome.heartbeat).toBe(true);
    expect(received.map((request) => request.path).sort()).toEqual(["/all", "/hb/fail", "/slack"]);
  });

  it("sends successes only to targets that opted in", async () => {
    await notifyRun(report(), { ...FAST, targets: withBase(), heartbeat: `${baseUrl}/hb` });
    expect(received.map((request) => request.path).sort()).toEqual(["/all", "/discord", "/hb"]);
  });

  it("sends nothing for a skipped run", async () => {
    const outcome = await notifyRun(report({ status: "skipped" }), {
      ...FAST,
      targets: withBase(),
      heartbeat: `${baseUrl}/hb`,
    });
    expect(outcome).toEqual({ sent: [], heartbeat: undefined });
    expect(received).toHaveLength(0);
  });
});

describe("chat payload details", () => {
  it("leaves out the backup facts when the run failed before backing up", () => {
    const { backup: _backup, ...withoutBackup } = report({
      status: "failure",
      error: { step: "lock", code: "MS_LOCK_FAILED", message: "no lock" },
    });
    const text = JSON.stringify(slackPayload(withoutBackup));
    expect(text).not.toContain("raw →");
    expect(text).toContain("MS_LOCK_FAILED: no lock");
    expect(text).not.toContain("Hint:");
  });

  it("shows failed verifications and guard findings, but not a guard that passed", () => {
    const flagged = report({
      status: "failure",
      verify: { mode: "fast", ok: false, problems: [], attempts: 1 },
      guard: { ok: false, action: "fail", findings: [{ message: "users shrank by 90%" }] },
    });
    const text = JSON.stringify(discordPayload(flagged));
    expect(text).toContain("fast: FAILED");
    expect(text).toContain("1 finding(s), action fail");
    expect(text).toContain("• users shrank by 90%");

    const passed = report({ guard: { ok: true, action: "warn", findings: [] } });
    expect(JSON.stringify(slackPayload(passed))).not.toContain("finding(s)");
  });

  it("titles a checkpointed run as such", () => {
    expect(slackPayload(report({ status: "checkpointed" })).text).toContain("checkpointed");
  });

  it("truncates long error details and prints small sizes in bytes", () => {
    const long = report({
      status: "failure",
      error: { step: "backup", code: "MS_STORAGE_FAILED", message: "x".repeat(5000) },
      backup: {
        id: "2026-10-20T03-00-00Z_abcdef",
        namespaces: 1,
        documents: 1,
        bytesRaw: 512,
        bytesStored: 100,
        durationMs: 10,
        attempts: 1,
      },
    });
    const text = JSON.stringify(discordPayload(long));
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(3001));
    expect(text).toContain("512 B raw → 100 B stored");
  });
});

describe("webhook details", () => {
  it("sends checkpointed runs as backup.checkpointed", () => {
    expect(webhookPayload(report({ status: "checkpointed" })).event).toBe("backup.checkpointed");
  });

  it("signs with the current time when no timestamp is given", async () => {
    const before = Math.floor(Date.now() / 1000);
    expect(await sendWebhook(`${baseUrl}/hook`, report(), { ...FAST, secret: "s3cret" })).toBe(
      true,
    );
    const timestamp = Number(received[0]?.headers["x-mongoshield-timestamp"]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0]?.headers["x-mongoshield-signature"]).toBe(
      signWebhook(received[0]?.body ?? "", "s3cret", timestamp),
    );
  });

  it("signs webhooks sent by notifyRun with the webhook secret", async () => {
    await notifyRun(FAILURE, {
      ...FAST,
      targets: [{ type: "webhook", url: `${baseUrl}/signed` }],
      webhookSecret: "s3cret",
    });
    expect(received[0]?.headers["x-mongoshield-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("delivery edge cases", () => {
  it("does not ping an invalid heartbeat URL, and warns", async () => {
    const logger = spyLogger();
    expect(await pingHeartbeat("not a url", "success", { ...FAST, logger })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("The heartbeat URL is invalid; not pinging");
  });

  it("logs an invalid URL without its text and returns false", async () => {
    const logger = spyLogger();
    const sent = await sendHttp(
      { url: "::not-a-url", method: "GET", label: "test" },
      { ...FAST, logger },
    );
    expect(sent).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      expect.objectContaining({ host: "(invalid URL)" }),
    );
  });

  it("waits the default retry delay before retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      script = [503];
      const sending = sendHttp({ url: `${baseUrl}/retry`, method: "GET", label: "test" });
      // The first attempt fails; the retry waits for the (faked) default delay.
      await vi.waitFor(() => expect(received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(await sending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a body that cannot be read as delivered, and a non-Error rejection as a failure", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        status: 204,
        arrayBuffer: () => Promise.reject(new Error("body lost")),
      } as unknown as Response)
      .mockRejectedValue("socket hang up");
    vi.stubGlobal("fetch", fetchStub);
    try {
      const logger = spyLogger();
      const request = { url: "https://hooks.example.com/x", method: "POST" as const, label: "t" };
      expect(await sendHttp(request, { ...FAST, logger })).toBe(true);
      expect(await sendHttp(request, { ...FAST, logger })).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "socket hang up" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
