/**
 * Login providers built from a shipped OAuth app (src/storage/oauth/apps.ts): the
 * device flow for Google Drive and OneDrive, the browser flow with PKCE for Dropbox.
 * The provider modules (gdrive.ts, onedrive.ts, dropbox.ts) start from these and add
 * whatever their provider needs on top.
 *
 *   export const gdriveLoginProvider = deviceLoginProvider(OAUTH_APPS.gdrive);
 */

import { MongoShieldError } from "../../errors.ts";
import { type OAuthApp, resolveOAuthClient } from "../../storage/oauth/apps.ts";
import { runBrowserFlow } from "../../storage/oauth/browser-flow.ts";
import { runDeviceFlow } from "../../storage/oauth/device-flow.ts";
import type { OAuthTokenSet } from "../../storage/oauth/token-endpoint.ts";
import type { LoginContext, LoginProvider, LoginResult } from "./types.ts";

/** A provider that signs in with the device flow (RFC 8628). */
export function deviceLoginProvider(app: OAuthApp): LoginProvider {
  const deviceAuthorizationUrl = app.endpoints.deviceAuthorization;
  if (deviceAuthorizationUrl === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `${app.displayName} has no device flow endpoint.`);
  }
  return {
    id: app.provider,
    displayName: app.displayName,
    tokenEnv: app.env.token,
    flow: "device",
    async login(context: LoginContext): Promise<LoginResult> {
      const tokens = await runDeviceFlow({
        service: app.displayName,
        deviceAuthorizationUrl,
        tokenUrl: app.endpoints.token,
        client: resolveOAuthClient(app.provider, context.env),
        scopes: app.scopes,
        onPrompt: (prompt) => context.show({ kind: "device-code", ...prompt }),
        signal: context.signal,
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      });
      return { refreshToken: refreshTokenOf(app, tokens) };
    },
  };
}

/** A provider that signs in in a local browser (authorization code + PKCE, loopback). */
export function browserLoginProvider(app: OAuthApp): LoginProvider {
  const authorizationUrl = app.endpoints.authorization;
  if (authorizationUrl === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `${app.displayName} has no authorization endpoint.`);
  }
  return {
    id: app.provider,
    displayName: app.displayName,
    tokenEnv: app.env.token,
    flow: "browser",
    async login(context: LoginContext): Promise<LoginResult> {
      const tokens = await runBrowserFlow({
        service: app.displayName,
        authorizationUrl,
        tokenUrl: app.endpoints.token,
        client: resolveOAuthClient(app.provider, context.env),
        scopes: app.scopes,
        ...(app.authorizationParams === undefined
          ? {}
          : { authorizationParams: app.authorizationParams }),
        onAuthorizationUrl: (url) => context.show({ kind: "open-url", url }),
        signal: context.signal,
        ...(context.port === undefined ? {} : { port: context.port }),
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      });
      return { refreshToken: refreshTokenOf(app, tokens) };
    },
  };
}

/** The refresh token of a sign-in; without one the login is useless for nightly runs. */
function refreshTokenOf(app: OAuthApp, tokens: OAuthTokenSet): string {
  if (tokens.refreshToken === undefined) {
    throw new MongoShieldError(
      "MS_STORAGE_FORBIDDEN",
      `${app.displayName} signed in but returned no refresh token, so backups could not run unattended.`,
      {
        hint: `Check that the app asks for offline access, then run \`mongoshield login ${app.provider}\` again.`,
      },
    );
  }
  return tokens.refreshToken;
}
