/**
 * The OAuth 2.0 device authorization grant (RFC 8628), used by `mongoshield login`
 * for Google Drive: it works over SSH and in Codespaces, because the
 * person approves on any other device.
 *
 *   1. POST the device authorization endpoint → device_code, user_code, verification URL
 *   2. show the user code and the URL (the `onPrompt` callback)
 *   3. poll the token endpoint every `interval` seconds (default 5) until the person
 *      approves (tokens), declines (`access_denied`) or the code expires
 *      (`expired_token`); `authorization_pending` means "keep polling", and
 *      `slow_down` adds 5 seconds to the interval for good (RFC 8628 §3.5).
 *
 * Google names the URL `verification_url`, the RFC `verification_uri`;
 * both are read.
 */

import { setTimeout as sleepFor } from "node:timers/promises";
import { abortError, MongoShieldError, throwIfAborted } from "../../errors.ts";
import { createHttpClient } from "../http/client.ts";
import type { OAuthClient } from "./apps.ts";
import {
  numberField,
  type OAuthTokenSet,
  requestTokens,
  stringField,
  type TokenEndpointOptions,
} from "./token-endpoint.ts";

/** The RFC 8628 grant type for the polling requests. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Polling interval when the server names none (RFC 8628 §3.2). */
const DEFAULT_INTERVAL_SECONDS = 5;

/** What `slow_down` adds to the interval (RFC 8628 §3.5). */
const SLOW_DOWN_SECONDS = 5;

/** What the person has to do, for the `onPrompt` callback. */
export interface DeviceAuthorizationPrompt {
  /** The short code to type in, e.g. `WDJB-MJHT`. Not a secret on its own. */
  readonly userCode: string;
  /** Where to type it, e.g. `https://www.google.com/device`. */
  readonly verificationUri: string;
  /** The same URL with the code filled in, when the provider offers one. */
  readonly verificationUriComplete?: string;
  /** When the code stops working. */
  readonly expiresAt: Date;
}

/** Options for {@link runDeviceFlow}. */
export interface DeviceFlowOptions extends TokenEndpointOptions {
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly scopes: readonly string[];
  /** Shows the code and URL to the person (the CLI prints them on stderr). */
  readonly onPrompt: (prompt: DeviceAuthorizationPrompt) => void | Promise<void>;
  /** Waits between polls; injectable for tests. Must reject when the signal fires. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Runs the device flow to the end and returns the tokens.
 *
 * @throws MS_STORAGE_FORBIDDEN when the person declines (`access_denied`) or the
 *   provider refuses the client; MS_TIMEOUT when the code expires before approval;
 *   MS_CONFIG_INVALID for a client the provider does not know (`invalid_client`);
 *   MS_ABORTED when the signal fires (Ctrl-C); MS_STORAGE_IO for network failures.
 */
export async function runDeviceFlow(options: DeviceFlowOptions): Promise<OAuthTokenSet> {
  const { service, signal } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const authorization = await requestDeviceCode(options);
  const deadline = now() + authorization.expiresInSeconds * 1000;
  await options.onPrompt({
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    ...(authorization.verificationUriComplete === undefined
      ? {}
      : { verificationUriComplete: authorization.verificationUriComplete }),
    expiresAt: new Date(deadline),
  });

  let intervalSeconds = authorization.intervalSeconds;
  for (;;) {
    try {
      await sleep(intervalSeconds * 1000, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    }
    throwIfAborted(signal);
    const result = await requestTokens(
      options.tokenUrl,
      options.client,
      { grant_type: DEVICE_GRANT_TYPE, device_code: authorization.deviceCode },
      { ...options, idempotent: true, operation: "check whether the sign-in was approved" },
    );
    if (result.ok) return result.tokens;

    switch (result.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalSeconds += SLOW_DOWN_SECONDS;
        break;
      case "access_denied":
        throw new MongoShieldError("MS_STORAGE_FORBIDDEN", `The ${service} sign-in was declined.`, {
          hint: "Run the login again and choose Allow on the consent screen.",
        });
      case "expired_token":
        throw expiredError(service);
      default:
        throw oauthError(service, result.error, result.description);
    }
    // Some servers keep answering "pending" after the code expired; stop on our side too.
    if (now() >= deadline) throw expiredError(service);
  }
}

/** Step 1: the device code, user code and verification URL. */
async function requestDeviceCode(options: DeviceFlowOptions): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | undefined;
  expiresInSeconds: number;
  intervalSeconds: number;
}> {
  const { service } = options;
  const http = createHttpClient({
    service,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...options.http,
  });
  const body = new URLSearchParams({
    client_id: options.client.clientId,
    scope: options.scopes.join(" "),
  });
  if (options.client.clientSecret !== undefined) {
    body.set("client_secret", options.client.clientSecret);
  }
  const response = await http.request({
    method: "POST",
    url: options.deviceAuthorizationUrl,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    operation: "start the sign-in",
    accept: [400, 401],
    // Asking twice only creates a second code; the first is never shown.
    idempotent: true,
    signal: options.signal,
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw oauthError(
      service,
      stringField(json, "error") ?? `http_${response.status}`,
      stringField(json, "error_description"),
    );
  }
  const deviceCode = stringField(json, "device_code");
  const userCode = stringField(json, "user_code");
  const verificationUri =
    stringField(json, "verification_uri") ?? stringField(json, "verification_url");
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `${service} answered the sign-in request without a device code, user code or verification URL.`,
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      stringField(json, "verification_uri_complete") ??
      stringField(json, "verification_url_complete"),
    // RFC 8628 makes expires_in required; 15 minutes is what providers use in practice.
    expiresInSeconds: numberField(json, "expires_in") ?? 900,
    intervalSeconds: Math.max(1, numberField(json, "interval") ?? DEFAULT_INTERVAL_SECONDS),
  };
}

function expiredError(service: string): MongoShieldError {
  return new MongoShieldError(
    "MS_TIMEOUT",
    `The ${service} sign-in code expired before it was approved.`,
    { hint: "Run the login again and enter the new code within a few minutes." },
  );
}

/**
 * Any other OAuth error. `invalid_client` and `unauthorized_client` are configuration
 * problems (the client id is wrong or the app does not allow this flow).
 */
export function oauthError(
  service: string,
  error: string,
  description: string | undefined,
): MongoShieldError {
  const detail = description === undefined ? error : `${error}: ${description}`;
  if (error === "invalid_client" || error === "unauthorized_client" || error === "invalid_scope") {
    return new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${service} refused the OAuth client (${detail}).`,
      {
        hint: "Check MONGOSHIELD_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET, and that the app allows this sign-in flow and scope.",
        details: { service, oauthError: error },
      },
    );
  }
  return new MongoShieldError(
    "MS_STORAGE_FORBIDDEN",
    `${service} refused the sign-in (${detail}).`,
    {
      hint: "Run the login again; if it keeps failing, check the app's settings at the provider.",
      details: { service, oauthError: error },
    },
  );
}

async function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await sleepFor(ms, undefined, signal === undefined ? {} : { signal });
}
