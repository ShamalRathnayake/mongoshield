/**
 * Talking to the identity provider: discovery and signing keys.
 *
 *   discovery   GET <issuer>/.well-known/openid-configuration (OpenID Connect
 *               Discovery 1.0), cached for an hour. Its `issuer` must equal the
 *               configured issuer exactly, so a document served by another
 *               issuer (mix-up) is refused.
 *   keys        GET <jwks_uri>, cached for an hour. A token signed with a key id
 *               the cache does not know triggers one refresh (key rotation: the
 *               provider published a new key), but at most once per cooldown, so
 *               tokens with made-up key ids cannot make the console hammer the
 *               provider.
 *
 * Every request has a timeout, refuses redirects (the configured URLs are the
 * only ones the console talks to) and a size limit; endpoints must be https
 * except on loopback addresses (local development and the tests).
 */

import { OidcError } from "./errors.ts";
import { type DecodedJws, importJwk, type PublicJwk, type SupportedAlgorithm } from "./jose.ts";

/** What the console uses from the discovery document. */
export interface ProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** How to authenticate at the token endpoint with a client secret. */
  readonly tokenAuthMethod: "client_secret_basic" | "client_secret_post";
}

/** Options for {@link OidcProvider}; the durations exist so tests can shorten them. */
export interface OidcProviderOptions {
  readonly issuer: string;
  /** How long discovery and keys are cached. Default one hour. */
  readonly cacheMs?: number;
  /** Least time between two key refreshes caused by unknown key ids. Default 60 s. */
  readonly refreshCooldownMs?: number;
  /** Per-request timeout. Default 10 s. */
  readonly timeoutMs?: number;
  /** The clock (milliseconds). */
  readonly now?: () => number;
}

const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_COOLDOWN_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Discovery documents and key sets are a few KiB; 1 MiB is generous. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Discovery and keys of one issuer, cached. */
export class OidcProvider {
  readonly issuer: string;
  readonly #cacheMs: number;
  readonly #refreshCooldownMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #metadata: { readonly value: ProviderMetadata; readonly fetchedAt: number } | undefined;
  #keys: { readonly value: readonly PublicJwk[]; readonly fetchedAt: number } | undefined;
  /** When unknown key ids last caused a refresh. */
  #lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(options: OidcProviderOptions) {
    this.issuer = options.issuer;
    this.#cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.#refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The provider's endpoints (from cache when fresh). */
  async metadata(): Promise<ProviderMetadata> {
    const cached = this.#metadata;
    if (cached !== undefined && this.#now() - cached.fetchedAt < this.#cacheMs) return cached.value;
    const url = `${this.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const value = parseMetadata(await this.#getJson(url), this.issuer);
    this.#metadata = { value, fetchedAt: this.#now() };
    return value;
  }

  /**
   * The keys that may have signed `jws` with `algorithm`: the one with its `kid`,
   * or every key when the token names none. Refreshes the key set once if the
   * `kid` is unknown (see the file header).
   */
  async candidateKeys(jws: DecodedJws, algorithm: SupportedAlgorithm): Promise<PublicJwk[]> {
    const keyId = typeof jws.header.kid === "string" ? jws.header.kid : undefined;
    let keys = await this.#currentKeys(false);
    const known = keyId === undefined || keys.some((key) => key.keyId === keyId);
    if (!known && this.#now() - this.#lastForcedRefreshAt >= this.#refreshCooldownMs) {
      this.#lastForcedRefreshAt = this.#now();
      keys = await this.#currentKeys(true);
    }
    return keys.filter(
      (key) =>
        (keyId === undefined || key.keyId === keyId) &&
        // A key pinned to another algorithm must not be used with this one.
        (key.algorithm === undefined || key.algorithm === algorithm),
    );
  }

  async #currentKeys(force: boolean): Promise<readonly PublicJwk[]> {
    const cached = this.#keys;
    if (!force && cached !== undefined && this.#now() - cached.fetchedAt < this.#cacheMs) {
      return cached.value;
    }
    const { jwksUri } = await this.metadata();
    const value = parseKeySet(await this.#getJson(jwksUri));
    this.#keys = { value, fetchedAt: this.#now() };
    return value;
  }

  /** POSTs a form to the token endpoint and returns the JSON answer with its status. */
  async postForm(
    url: string,
    form: URLSearchParams,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }> {
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...headers,
      },
      body: form.toString(),
    });
    return { status: response.status, body: await readJsonObject(response, url) };
  }

  async #getJson(url: string): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) {
      throw new OidcError(
        "CONSOLE_OIDC_UNAVAILABLE",
        `${url} answered with HTTP ${response.status}.`,
      );
    }
    return readJsonObject(response, url);
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        // The console talks only to the URLs it was configured with or discovered.
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new OidcError(
        "CONSOLE_OIDC_UNAVAILABLE",
        `Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Reads a JSON object body of at most {@link MAX_RESPONSE_BYTES}. */
async function readJsonObject(
  response: Response,
  url: string,
): Promise<Readonly<Record<string, unknown>>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", `${url} sent a response that is too large.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", `${url} sent a response that is too large.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", `${url} did not answer with JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", `${url} did not answer with a JSON object.`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * True for URLs the console may talk to: https anywhere, http only on loopback
 * hosts (a provider on the same machine, or the tests' fake provider).
 */
export function isAllowedEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** `localhost`, `127.x.x.x` or `[::1]`. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Checks and extracts what the console needs from a discovery document. */
function parseMetadata(
  document: Readonly<Record<string, unknown>>,
  issuer: string,
): ProviderMetadata {
  if (document.issuer !== issuer) {
    throw new OidcError(
      "CONSOLE_OIDC_UNAVAILABLE",
      `The discovery document names issuer ${JSON.stringify(document.issuer)}, not ${JSON.stringify(issuer)}.`,
    );
  }
  const endpoint = (name: string): string => {
    const value = document[name];
    if (typeof value !== "string" || !isAllowedEndpoint(value)) {
      throw new OidcError(
        "CONSOLE_OIDC_UNAVAILABLE",
        `The discovery document has no usable ${name} (it must be an https URL).`,
      );
    }
    return value;
  };
  const responseTypes = document.response_types_supported;
  if (Array.isArray(responseTypes) && !responseTypes.includes("code")) {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", "The provider does not support the code flow.");
  }
  const challengeMethods = document.code_challenge_methods_supported;
  // Absent means "not advertised" (many providers support PKCE without saying so).
  if (Array.isArray(challengeMethods) && !challengeMethods.includes("S256")) {
    throw new OidcError(
      "CONSOLE_OIDC_UNAVAILABLE",
      "The provider does not support PKCE with S256.",
    );
  }
  const authMethods = document.token_endpoint_auth_methods_supported;
  // RFC 8414: the default when the list is absent is client_secret_basic.
  const tokenAuthMethod =
    Array.isArray(authMethods) &&
    !authMethods.includes("client_secret_basic") &&
    authMethods.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic";
  return {
    issuer,
    authorizationEndpoint: endpoint("authorization_endpoint"),
    tokenEndpoint: endpoint("token_endpoint"),
    jwksUri: endpoint("jwks_uri"),
    tokenAuthMethod,
  };
}

/** The usable signing keys of a JWKS. Unusable keys are skipped, not fatal. */
function parseKeySet(document: Readonly<Record<string, unknown>>): PublicJwk[] {
  const keys = document.keys;
  if (!Array.isArray(keys)) {
    throw new OidcError("CONSOLE_OIDC_UNAVAILABLE", "The provider's JWKS has no keys list.");
  }
  const usable: PublicJwk[] = [];
  for (const entry of keys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    try {
      usable.push(importJwk(Object.fromEntries(Object.entries(entry))));
    } catch {
      // Encryption keys, unknown key types and broken entries are not for us.
    }
  }
  return usable;
}
