/**
 * Access tokens from a refresh token (RFC 6749 §6), cached per adapter instance.
 *
 *   const tokens = createAccessTokenSource({
 *     service: "Google Drive",
 *     tokenUrl: OAUTH_APPS.gdrive.endpoints.token,
 *     client: resolveOAuthClient("gdrive", env),
 *     refreshToken: env.MONGOSHIELD_GDRIVE_TOKEN,
 *   });
 *   const http = createHttpClient({ service: "Google Drive", auth: tokens });
 *
 * - The access token is kept in memory only, and refreshed `refreshMarginMs` (60 s)
 *   before it expires, so a request never goes out with a token about to lapse.
 *   Concurrent callers share one refresh. Nothing is written anywhere: adapters stay
 *   stateless across runs, and every run starts with one refresh.
 * - Providers that rotate refresh tokens (Microsoft returns a new one on every
 *   refresh, and the old one expires 90 days after issue) hand the new one to
 *   `onRefreshTokenRotated`, which the OneDrive adapter uses to persist it; later
 *   refreshes in this process use the new one too.
 * - A revoked or expired refresh token (`invalid_grant`) becomes MS_STORAGE_FORBIDDEN
 *   with `authHint` (run `mongoshield login <provider>` again).
 */

import { MongoShieldError, throwIfAborted } from "../../errors.ts";
import type { HttpAuth } from "../http/client.ts";
import type { OAuthClient } from "./apps.ts";
import { oauthError } from "./device-flow.ts";
import { requestTokens, type TokenEndpointOptions } from "./token-endpoint.ts";

/** How long before expiry a cached access token is replaced. */
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

/** Assumed lifetime when the token endpoint names none (one hour, the usual value). */
const DEFAULT_LIFETIME_MS = 60 * 60_000;

/** Options for {@link createAccessTokenSource}. */
export interface AccessTokenSourceOptions extends Omit<TokenEndpointOptions, "signal"> {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  /** The long-lived refresh token (`MONGOSHIELD_<PROVIDER>_TOKEN`). A secret. */
  readonly refreshToken: string;
  /** Scopes to ask for on refresh; providers that need them (Microsoft) list them here. */
  readonly scopes?: readonly string[];
  /** Replace the cached token this long before it expires. Default 60 s. */
  readonly refreshMarginMs?: number;
  /**
   * Called with the new refresh token when the provider rotates it. Awaited before the
   * new access token is handed out; an error it throws fails that request.
   */
  readonly onRefreshTokenRotated?: (refreshToken: string) => void | Promise<void>;
  /** The hint for a refresh token the provider no longer accepts. */
  readonly authHint?: string;
}

/** What {@link createAccessTokenSource} returns: an `HttpAuth` for the HTTP client. */
export interface AccessTokenSource extends HttpAuth {
  /** The refresh token in use now (it changes when the provider rotates it). A secret. */
  currentRefreshToken(): string;
}

/** Creates the token source; see the file header. */
export function createAccessTokenSource(options: AccessTokenSourceOptions): AccessTokenSource {
  const now = options.now ?? Date.now;
  const margin = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  if (typeof options.refreshToken !== "string" || options.refreshToken.trim() === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", `No ${options.service} refresh token.`, {
      ...(options.authHint === undefined ? {} : { hint: options.authHint }),
    });
  }
  let refreshToken = options.refreshToken.trim();
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function refresh(signal: AbortSignal | undefined): Promise<string> {
    const result = await requestTokens(
      options.tokenUrl,
      options.client,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...(options.scopes === undefined || options.scopes.length === 0
          ? {}
          : { scope: options.scopes.join(" ") }),
      },
      // Not repeated after a network error: with rotation, the first try may have
      // consumed the refresh token.
      { ...options, signal, idempotent: false, operation: "refresh the access token" },
    );
    if (!result.ok) {
      if (result.error === "invalid_grant") {
        throw new MongoShieldError(
          "MS_STORAGE_FORBIDDEN",
          `${options.service} no longer accepts the saved refresh token (revoked, expired or replaced).`,
          {
            ...(options.authHint === undefined ? {} : { hint: options.authHint }),
            details: { service: options.service, oauthError: result.error },
          },
        );
      }
      throw oauthError(options.service, result.error, result.description);
    }
    const { tokens } = result;
    if (tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken) {
      await options.onRefreshTokenRotated?.(tokens.refreshToken);
      refreshToken = tokens.refreshToken;
    }
    cached = {
      token: tokens.accessToken,
      expiresAt: tokens.expiresAt ?? now() + DEFAULT_LIFETIME_MS,
    };
    return tokens.accessToken;
  }

  return {
    async getAccessToken(request = {}) {
      throwIfAborted(request.signal);
      if (request.forceRefresh === true) cached = undefined;
      if (cached !== undefined && now() < cached.expiresAt - margin) return cached.token;
      // One refresh at a time; everyone waiting gets its result.
      if (inFlight === undefined) {
        const attempt = refresh(request.signal);
        inFlight = attempt;
        attempt.then(
          () => {
            if (inFlight === attempt) inFlight = undefined;
          },
          () => {
            if (inFlight === attempt) inFlight = undefined;
          },
        );
      }
      return inFlight;
    },
    currentRefreshToken: () => refreshToken,
  };
}
