/**
 * `mongoshield login dropbox`: Dropbox, which has no device flow, so the person signs
 * in in a browser on this machine (authorization code + PKCE, redirected back to
 * http://127.0.0.1:<port>/callback). `--port` fixes the port when the Dropbox app
 * only allows registered redirect URIs.
 *
 * The refresh token goes in MONGOSHIELD_DROPBOX_TOKEN (an offline token:
 * `token_access_type=offline`).
 *
 * This module belongs to the Dropbox release: it may replace the generic provider
 * below with one that does more.
 */

import { OAUTH_APPS } from "../../storage/oauth/apps.ts";
import { browserLoginProvider } from "./flows.ts";
import type { LoginProvider } from "./types.ts";

/** The Dropbox login provider. */
export const dropboxLoginProvider: LoginProvider = browserLoginProvider(OAUTH_APPS.dropbox);
