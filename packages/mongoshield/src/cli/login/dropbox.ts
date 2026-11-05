/**
 * `mongoshield login dropbox`: Dropbox, with the authorization code flow and PKCE
 * (Dropbox has no device flow) and only the App folder's scopes.
 *
 * The sign-in is the Dropbox adapter's own (src/storage/dropbox-auth.ts):
 * - on this machine, the browser comes back to http://127.0.0.1:53917/callback (or
 *   53918, or `--port`). Dropbox matches redirect URIs exactly, so these are the ports
 *   registered for MongoShield's app;
 * - over SSH, in a Codespace, or with both ports busy, Dropbox shows a code instead,
 *   which the person pastes (context.readCode).
 * The refresh token goes in MONGOSHIELD_DROPBOX_TOKEN.
 */

import {
  DROPBOX_LOOPBACK_PORTS,
  DROPBOX_SECRET_NAME,
  loginDropbox,
  resolveDropboxClient,
} from "../../storage/dropbox-auth.ts";
import type { LoginContext, LoginProvider, LoginResult } from "./types.ts";

/** The Dropbox login provider. */
export const dropboxLoginProvider: LoginProvider = {
  id: "dropbox",
  displayName: "Dropbox",
  tokenEnv: DROPBOX_SECRET_NAME,
  flow: "browser",
  async login(context: LoginContext): Promise<LoginResult> {
    const env = { ...context.env };
    const client = resolveDropboxClient(env);
    const result = await loginDropbox({
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      env,
      signal: context.signal,
      // A fixed --port must be registered with the app too (bring-your-own apps).
      ports: context.port === undefined ? DROPBOX_LOOPBACK_PORTS : [context.port],
      // Without a terminal nobody can paste a code, so only the loopback can work.
      ...(context.readCode === undefined ? { mode: "loopback" } : { readCode: context.readCode }),
      ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      onPrompt: (prompt) =>
        context.show({
          kind: "open-url",
          url: prompt.verificationUrl,
          paste: prompt.mode === "paste",
        }),
    });
    return { refreshToken: result.refreshToken };
  },
};
