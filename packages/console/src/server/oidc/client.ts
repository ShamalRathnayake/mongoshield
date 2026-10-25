/**
 * The OIDC relying party: authorization code flow with PKCE (RFC 7636), `state`
 * and `nonce`, and ID token verification.
 *
 *   begin()     new pending login: random state, nonce and PKCE verifier, kept in
 *               memory under a random transaction id; returns the provider URL.
 *               The route stores the transaction id in a short-lived cookie, which
 *               binds the login to the browser that started it.
 *   complete()  takes (and forgets) the pending login of that cookie, checks
 *               `state`, exchanges the code (with the PKCE verifier) for tokens,
 *               and verifies the ID token. Returns its claims.
 *
 * What each check prevents:
 *   state + cookie    login CSRF: an attacker cannot make a victim's browser finish
 *                     a sign-in the attacker started (the victim has no cookie for it)
 *   PKCE (S256)       a stolen authorization code is useless without the verifier
 *   nonce             a captured ID token cannot be replayed into another login
 *   iss / aud / azp   tokens from another issuer, or for another client, are refused
 *   exp / nbf / iat   expired and not-yet-valid tokens are refused (with clock skew)
 *   signature         RS256 / ES256 / EdDSA against the provider's JWKS (jose.ts)
 *
 * Pending logins live in memory: a restart in the middle of a sign-in only means
 * signing in again. They expire after 10 minutes and are capped in number, so
 * anonymous requests to the login endpoint cannot exhaust memory.
 */

import { createHash } from "node:crypto";
import { constantTimeEqual, randomToken } from "../../state/crypto.ts";
import { OidcError } from "./errors.ts";
import { decodeJws, isSupportedAlgorithm, JoseError, verifyJws } from "./jose.ts";
import { OidcProvider, type OidcProviderOptions } from "./provider.ts";
import type { IdTokenClaims, OidcSettings } from "./settings.ts";

/** How long a sign-in may take between leaving for the provider and coming back. */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Most sign-ins pending at once; the oldest is dropped beyond this. */
const MAX_PENDING_LOGINS = 1000;
/** Longest `sub` accepted (OIDC Core §2: at most 255 ASCII characters). */
const MAX_SUBJECT_LENGTH = 255;

/** A sign-in waiting for the provider's redirect back. */
interface PendingLogin {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly startedAt: number;
}

/** What the callback received in its query string. */
export interface CallbackParams {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
  /** RFC 9207 `iss`: providers that send it name themselves, which defeats mix-up attacks. */
  readonly iss?: string | undefined;
}

/** Options for {@link OidcClient}. */
export interface OidcClientOptions {
  readonly settings: OidcSettings;
  /** The clock (milliseconds); the console passes its own so tests can move it. */
  readonly now?: () => number;
  /** Cache and timeout overrides for the provider (tests). */
  readonly provider?: Omit<OidcProviderOptions, "issuer" | "now">;
}

/** Signs people in with one OIDC provider. */
export class OidcClient {
  readonly settings: OidcSettings;
  readonly provider: OidcProvider;
  readonly #now: () => number;
  /** Pending logins by transaction id, oldest first (Map keeps insertion order). */
  readonly #pending = new Map<string, PendingLogin>();

  constructor(options: OidcClientOptions) {
    this.settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.provider = new OidcProvider({
      issuer: options.settings.issuer,
      now: this.#now,
      ...options.provider,
    });
  }

  /** Number of sign-ins waiting for the provider (for tests and metrics). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Starts a sign-in. Returns the transaction id (for the cookie) and the URL to
   * send the browser to.
   *
   * @throws OidcError `CONSOLE_OIDC_UNAVAILABLE` when discovery fails.
   */
  async begin(): Promise<{ readonly transactionId: string; readonly url: string }> {
    const metadata = await this.provider.metadata();
    this.#dropExpired();
    const login: PendingLogin = {
      state: randomToken(),
      nonce: randomToken(),
      // 32 random bytes as base64url: 43 characters, within RFC 7636's 43-128.
      codeVerifier: randomToken(),
      startedAt: this.#now(),
    };
    const transactionId = randomToken();
    this.#pending.set(transactionId, login);
    for (const oldest of this.#pending.keys()) {
      if (this.#pending.size <= MAX_PENDING_LOGINS) break;
      this.#pending.delete(oldest);
    }

    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.settings.clientId);
    url.searchParams.set("redirect_uri", this.settings.redirectUrl);
    url.searchParams.set("scope", this.settings.scopes.join(" "));
    url.searchParams.set("state", login.state);
    url.searchParams.set("nonce", login.nonce);
    url.searchParams.set("code_challenge", codeChallengeOf(login.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { transactionId, url: url.toString() };
  }

  /**
   * Finishes a sign-in and returns the verified ID token claims. The pending login
   * is consumed whatever the outcome, so a callback URL works at most once.
   *
   * @throws OidcError with the reason (see `OidcErrorCode` in src/shared/api.ts).
   */
  async complete(
    transactionId: string | undefined,
    params: CallbackParams,
  ): Promise<IdTokenClaims> {
    const login = transactionId === undefined ? undefined : this.#pending.get(transactionId);
    if (transactionId !== undefined) this.#pending.delete(transactionId);
    if (login === undefined) {
      throw new OidcError(
        "CONSOLE_OIDC_STATE",
        "No sign-in is pending for this browser (missing or unknown transaction cookie).",
      );
    }
    if (this.#now() - login.startedAt > PENDING_LOGIN_TTL_MS) {
      throw new OidcError("CONSOLE_OIDC_STATE", "The sign-in took longer than 10 minutes.");
    }
    if (params.state === undefined || !constantTimeEqual(params.state, login.state)) {
      throw new OidcError("CONSOLE_OIDC_STATE", "The state parameter does not match.");
    }
    if (params.iss !== undefined && params.iss !== this.settings.issuer) {
      throw new OidcError("CONSOLE_OIDC_INVALID_TOKEN", "The callback names another issuer.");
    }
    if (params.error !== undefined) {
      // Only the error code, which is from a fixed vocabulary (RFC 6749 §4.1.2.1);
      // error_description is free text from the network and is not logged.
      throw new OidcError(
        "CONSOLE_OIDC_PROVIDER_ERROR",
        `The provider refused the sign-in: ${params.error.slice(0, 64)}.`,
      );
    }
    if (params.code === undefined || params.code === "" || params.code.length > 4096) {
      throw new OidcError(
        "CONSOLE_OIDC_PROVIDER_ERROR",
        "The callback carries no authorization code.",
      );
    }
    const idToken = await this.#exchangeCode(params.code, login.codeVerifier);
    return this.verifyIdToken(idToken, login.nonce);
  }

  /** Redeems the authorization code at the token endpoint; returns the raw ID token. */
  async #exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const metadata = await this.provider.metadata();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.settings.redirectUrl,
      code_verifier: codeVerifier,
    });
    const headers: Record<string, string> = {};
    const secret = this.settings.clientSecret;
    if (secret === undefined) {
      // Public client: PKCE alone protects the code; the client id identifies us.
      form.set("client_id", this.settings.clientId);
    } else if (metadata.tokenAuthMethod === "client_secret_post") {
      form.set("client_id", this.settings.clientId);
      form.set("client_secret", secret);
    } else {
      // RFC 6749 §2.3.1: id and secret are form-encoded before Basic encoding.
      const credentials = `${formEncode(this.settings.clientId)}:${formEncode(secret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    }
    const { status, body } = await this.provider.postForm(metadata.tokenEndpoint, form, headers);
    if (status >= 400 && status < 500) {
      const error = typeof body.error === "string" ? body.error.slice(0, 64) : `HTTP ${status}`;
      throw new OidcError(
        "CONSOLE_OIDC_PROVIDER_ERROR",
        `The token endpoint refused the code: ${error}.`,
      );
    }
    if (status !== 200) {
      throw new OidcError(
        "CONSOLE_OIDC_UNAVAILABLE",
        `The token endpoint answered with HTTP ${status}.`,
      );
    }
    if (typeof body.id_token !== "string") {
      throw new OidcError("CONSOLE_OIDC_INVALID_TOKEN", "The token response has no ID token.");
    }
    return body.id_token;
  }

  /**
   * Verifies an ID token's signature and claims (see the file header) and returns
   * its claims. Public so the checks can be tested one by one.
   *
   * @throws OidcError `CONSOLE_OIDC_INVALID_TOKEN` (or `_UNAVAILABLE` when keys cannot be fetched).
   */
  async verifyIdToken(token: string, expectedNonce: string): Promise<IdTokenClaims> {
    let jws: ReturnType<typeof decodeJws>;
    try {
      jws = decodeJws(token);
    } catch (error) {
      throw invalidToken(error instanceof JoseError ? error.message : "The ID token is malformed.");
    }
    const algorithm = jws.header.alg;
    if (!isSupportedAlgorithm(algorithm)) {
      throw invalidToken(`The ID token algorithm ${JSON.stringify(algorithm)} is not accepted.`);
    }
    // RFC 7515 §4.1.11: extensions marked critical must be understood; we know none.
    if (jws.header.crit !== undefined) throw invalidToken("The ID token has critical extensions.");

    const keys = await this.provider.candidateKeys(jws, algorithm);
    if (keys.length === 0) throw invalidToken("No provider key matches the ID token's key id.");
    if (!keys.some((candidate) => verifyJws(jws, algorithm, candidate.key))) {
      throw invalidToken("The ID token signature is invalid.");
    }
    this.#checkClaims(jws.payload, expectedNonce);
    return jws.payload;
  }

  #checkClaims(claims: IdTokenClaims, expectedNonce: string): void {
    const { issuer, clientId, clockSkewMs } = this.settings;
    const now = this.#now();
    if (claims.iss !== issuer) throw invalidToken("The ID token is from another issuer.");

    const audience = claims.aud;
    const audiences =
      typeof audience === "string" ? [audience] : Array.isArray(audience) ? audience : [];
    if (!audiences.includes(clientId)) throw invalidToken("The ID token is for another client.");
    // OIDC Core §3.1.3.7: with several audiences, the authorized party must be us.
    if (audiences.length > 1 && claims.azp !== clientId) {
      throw invalidToken(
        "The ID token has several audiences and is not authorized for this client.",
      );
    }
    if (claims.azp !== undefined && claims.azp !== clientId) {
      throw invalidToken("The ID token was issued to another client (azp).");
    }

    const exp = numericDate(claims.exp);
    if (exp === undefined) throw invalidToken("The ID token has no expiry.");
    if (now >= exp + clockSkewMs) throw invalidToken("The ID token has expired.");
    const nbf = numericDate(claims.nbf);
    if (claims.nbf !== undefined && nbf === undefined)
      throw invalidToken("The ID token's nbf is not a date.");
    if (nbf !== undefined && now < nbf - clockSkewMs)
      throw invalidToken("The ID token is not valid yet.");
    const iat = numericDate(claims.iat);
    if (iat === undefined) throw invalidToken("The ID token has no issue time.");
    if (iat > now + clockSkewMs) throw invalidToken("The ID token was issued in the future.");

    if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, expectedNonce)) {
      throw invalidToken("The ID token's nonce does not match this sign-in.");
    }
    if (
      typeof claims.sub !== "string" ||
      claims.sub === "" ||
      claims.sub.length > MAX_SUBJECT_LENGTH
    ) {
      throw invalidToken("The ID token has no valid subject.");
    }
  }

  /** Forgets pending logins older than their time to live. */
  #dropExpired(): void {
    const cutoff = this.#now() - PENDING_LOGIN_TTL_MS;
    for (const [id, login] of this.#pending) {
      if (login.startedAt < cutoff) this.#pending.delete(id);
    }
  }
}

/** The PKCE S256 challenge: base64url(SHA-256(verifier)). */
export function codeChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A JWT NumericDate (seconds) as milliseconds, or undefined when it is not a number. */
function numericDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined;
}

/** application/x-www-form-urlencoded encoding of one value (spaces as `+`). */
function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function invalidToken(detail: string): OidcError {
  return new OidcError("CONSOLE_OIDC_INVALID_TOKEN", detail);
}
