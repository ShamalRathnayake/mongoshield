/**
 * `mongoshield login gdrive`: Google Drive, with the device flow (a code to approve on
 * any device) and only the `drive.file` scope (files MongoShield itself created).
 *
 * The refresh token goes in MONGOSHIELD_GDRIVE_TOKEN. Google's device flow needs the
 * app's (non-confidential) client secret too; apps.ts holds both.
 *
 * This module belongs to the Google Drive release: it may replace the generic
 * provider below with one that does more (e.g. checks the account's quota).
 */

import { OAUTH_APPS } from "../../storage/oauth/apps.ts";
import { deviceLoginProvider } from "./flows.ts";
import type { LoginProvider } from "./types.ts";

/** The Google Drive login provider. */
export const gdriveLoginProvider: LoginProvider = deviceLoginProvider(OAUTH_APPS.gdrive);
