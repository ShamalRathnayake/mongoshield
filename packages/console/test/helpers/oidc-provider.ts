/**
 * A small, real OpenID Connect provider for the console's SSO tests: a node:http
 * server on 127.0.0.1 that serves discovery, a JWKS and a token endpoint, and
 * signs ID tokens with RS256, ES256 or EdDSA keys it generates.
 *
 * There is no login page. A test plays the browser: it follows the console's
 * redirect to `/authorize`, reads `state`, `nonce` and `code_challenge` from the
 * URL, and calls {@link FakeOidcProvider.issueCode} to get the code the provider
 * would redirect back with. The token endpoint then checks the code, the client's
 * credentials and the PKCE verifier like a real provider, and answers with an ID
 * token whose claims and header a test can bend (`token` options) to exercise
 * every check the console makes.
 */

import {
  createHash,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  sign,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** An algorithm the fake provider signs with. */
export type FakeAlgorithm = "RS256" | "ES256" | "EdDSA";

/** A signing key of the provider. */
export interface FakeKey {
  readonly kid: string;
  readonly alg: FakeAlgorithm;
  readonly privateKey: KeyObject;
  /** The public JWK as published (extra members may be bent by tests). */
  jwk: Record<string, unknown>;
}

/** How to shape the ID token for one code. */
export interface TokenOptions {
  /** Claims merged over the defaults; a value of `undefined` removes the claim. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Header members merged over `{ alg, kid, typ }`; `undefined` removes one. */
  readonly header?: Readonly<Record<string, unknown>>;
  /** Sign with this key (default: the first published key). */
  readonly key?: FakeKey | undefined;
  /** Replace the whole token (malformed tokens, `alg: none`, …). */
  readonly rawToken?: (defaults: { header: string; payload: string }) => string;
  /** Answer the token request with this status and body instead. */
  readonly tokenResponse?: { readonly status: number; readonly body: unknown };
}

/** What the console sent to `/authorize` (parsed from its redirect). */
export interface AuthorizeRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly responseType: string;
}

/** Options for {@link FakeOidcProvider.start}. */
export interface FakeProviderOptions {
  readonly clientId?: string;
  /** Unset: a public client (no secret expected). */
  readonly clientSecret?: string | undefined;
  /** The provider's clock (ms); pass the console's test clock. */
  readonly now?: () => number;
  /** Algorithms of the initial keys (one key each). Default `["RS256"]`. */
  readonly algorithms?: readonly FakeAlgorithm[];
  /** Token endpoint auth methods to advertise. Default `["client_secret_basic"]`. */
  readonly authMethods?: readonly string[];
}

/** A code waiting to be redeemed. */
interface IssuedCode {
  readonly request: AuthorizeRequest;
  readonly options: TokenOptions;
  used: boolean;
}

/** The fake provider (see the file header). */
export class FakeOidcProvider {
  readonly server: Server;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  /** Signing keys; `published` decides which appear in the JWKS. */
  readonly keys: FakeKey[] = [];
  published: FakeKey[] = [];
  /** Members merged over the discovery document (undefined removes one). */
  discovery: Record<string, unknown> = {};
  /** Every request path received, e.g. "GET /jwks". */
  readonly requests: string[] = [];
  /** Token requests as received, to check what the console sent. */
  readonly tokenRequests: {
    readonly form: URLSearchParams;
    readonly authorization: string | undefined;
  }[] = [];
  /** Answer every request to this path with this status (e.g. a provider outage). */
  failures = new Map<string, number>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #now: () => number;
  readonly #authMethods: readonly string[];
  #nextKeyNumber = 1;

  private constructor(server: Server, issuer: string, options: FakeProviderOptions) {
    this.server = server;
    this.issuer = issuer;
    this.clientId = options.clientId ?? "mongoshield-console";
    this.clientSecret = "clientSecret" in options ? options.clientSecret : "test-client-secret";
    this.#now = options.now ?? Date.now;
    this.#authMethods = options.authMethods ?? ["client_secret_basic"];
  }

  /** Starts a provider on a random loopback port. */
  static async start(options: FakeProviderOptions = {}): Promise<FakeOidcProvider> {
    let provider: FakeOidcProvider | undefined;
    const server = createServer((request, response) => {
      provider?.handle(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    provider = new FakeOidcProvider(server, `http://127.0.0.1:${port}`, options);
    for (const alg of options.algorithms ?? ["RS256"]) provider.publish(provider.addKey(alg));
    return provider;
  }

  /** Stops the server. */
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Creates a key (not yet published unless `publish` is called). */
  addKey(alg: FakeAlgorithm, kid = `key-${this.#nextKeyNumber++}`, rsaBits = 2048): FakeKey {
    const pair =
      alg === "RS256"
        ? generateKeyPairSync("rsa", { modulusLength: rsaBits })
        : alg === "ES256"
          ? generateKeyPairSync("ec", { namedCurve: "P-256" })
          : generateKeyPairSync("ed25519");
    const exported: JsonWebKey = pair.publicKey.export({ format: "jwk" });
    const key: FakeKey = {
      kid,
      alg,
      privateKey: pair.privateKey,
      jwk: { ...exported, kid, alg, use: "sig" },
    };
    this.keys.push(key);
    return key;
  }

  /** Adds a key to the JWKS. */
  publish(key: FakeKey): void {
    this.published = [...this.published, key];
  }

  /**
   * What the provider's login page would do: remembers the console's request
   * and returns the authorization code to send back.
   */
  issueCode(
    authorizeUrl: string,
    options: TokenOptions = {},
  ): { code: string; request: AuthorizeRequest } {
    const url = new URL(authorizeUrl);
    const param = (name: string): string => url.searchParams.get(name) ?? "";
    const request: AuthorizeRequest = {
      state: param("state"),
      nonce: param("nonce"),
      codeChallenge: param("code_challenge"),
      codeChallengeMethod: param("code_challenge_method"),
      clientId: param("client_id"),
      redirectUri: param("redirect_uri"),
      scope: param("scope"),
      responseType: param("response_type"),
    };
    const code = `code-${createHash("sha256").update(`${Math.random()}`).digest("hex").slice(0, 24)}`;
    this.#codes.set(code, { request, options, used: false });
    return { code, request };
  }

  /** Signs a token like the token endpoint does (also used directly by unit-style tests). */
  signToken(nonce: string, options: TokenOptions = {}): string {
    const key = options.key ?? this.published[0] ?? this.keys[0];
    if (key === undefined) throw new Error("The fake provider has no key.");
    const nowSeconds = Math.floor(this.#now() / 1000);
    const claims = withOverrides(
      {
        iss: this.issuer,
        aud: this.clientId,
        sub: "user-123",
        exp: nowSeconds + 300,
        iat: nowSeconds,
        nonce,
        preferred_username: "alice",
        email: "alice@example.com",
        email_verified: true,
      },
      options.claims,
    );
    const header = withOverrides({ alg: key.alg, kid: key.kid, typ: "JWT" }, options.header);
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(claims));
    if (options.rawToken !== undefined) {
      return options.rawToken({ header: encodedHeader, payload: encodedPayload });
    }
    const input = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    const signature =
      key.alg === "RS256"
        ? sign("sha256", input, key.privateKey)
        : key.alg === "ES256"
          ? sign("sha256", input, { key: key.privateKey, dsaEncoding: "ieee-p1363" })
          : sign(null, input, key.privateKey);
    return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
  }

  /** Routes one HTTP request. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.issuer);
    this.requests.push(`${request.method} ${url.pathname}`);
    const failure = this.failures.get(url.pathname);
    if (failure !== undefined) return json(response, failure, { error: "server_error" });

    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(
        response,
        200,
        withOverrides(
          {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            jwks_uri: `${this.issuer}/jwks`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: this.#authMethods,
            id_token_signing_alg_values_supported: ["RS256", "ES256", "EdDSA"],
          },
          this.discovery,
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/jwks") {
      return json(response, 200, { keys: this.published.map((key) => key.jwk) });
    }
    if (request.method === "POST" && url.pathname === "/token") {
      return this.#token(request, response);
    }
    return json(response, 404, { error: "not_found" });
  }

  /** The token endpoint: code + client authentication + PKCE, like RFC 6749 / 7636. */
  async #token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    const authorization = request.headers.authorization;
    this.tokenRequests.push({ form, authorization });
    const issued = this.#codes.get(form.get("code") ?? "");
    if (issued?.options.tokenResponse !== undefined) {
      return json(response, issued.options.tokenResponse.status, issued.options.tokenResponse.body);
    }
    if (!this.#clientAuthenticated(form, authorization)) {
      return json(response, 401, { error: "invalid_client" });
    }
    if (
      issued === undefined ||
      issued.used ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("redirect_uri") !== issued.request.redirectUri
    ) {
      return json(response, 400, { error: "invalid_grant" });
    }
    issued.used = true;
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (
      issued.request.codeChallengeMethod !== "S256" ||
      challenge !== issued.request.codeChallenge
    ) {
      return json(response, 400, { error: "invalid_grant", error_description: "PKCE failed" });
    }
    return json(response, 200, {
      access_token: "unused-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: this.signToken(issued.request.nonce, issued.options),
    });
  }

  #clientAuthenticated(form: URLSearchParams, authorization: string | undefined): boolean {
    if (this.clientSecret === undefined) return form.get("client_id") === this.clientId;
    if (authorization?.startsWith("Basic ") === true) {
      const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const [id = "", secret = ""] = decoded
        .split(":")
        .map((part) => decodeURIComponent(part.replaceAll("+", " ")));
      return id === this.clientId && secret === this.clientSecret;
    }
    return (
      form.get("client_id") === this.clientId && form.get("client_secret") === this.clientSecret
    );
  }
}

/** `{ ...base, ...overrides }`, where an `undefined` override removes the member. */
function withOverrides(
  base: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}
