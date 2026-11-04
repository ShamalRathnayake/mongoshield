/**
 * `mongoshield login onedrive`: OneDrive (personal accounts), with the device flow and
 * the app-folder scope (`Files.ReadWrite.AppFolder`) plus `offline_access`.
 *
 * The refresh token goes in MONGOSHIELD_ONEDRIVE_TOKEN. Microsoft rotates it on every
 * refresh and expires it 90 days after issue; the OneDrive adapter handles that.
 *
 * This module belongs to the OneDrive release: it may replace the generic provider
 * below with one that does more.
 */

import { OAUTH_APPS } from "../../storage/oauth/apps.ts";
import { deviceLoginProvider } from "./flows.ts";
import type { LoginProvider } from "./types.ts";

/** The OneDrive login provider. */
export const onedriveLoginProvider: LoginProvider = deviceLoginProvider(OAUTH_APPS.onedrive);
