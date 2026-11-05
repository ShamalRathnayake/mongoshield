/**
 * `mongoshield login gdrive`: Google Drive, with the device flow (a code to approve on
 * any device) and only the `drive.file` scope (files MongoShield itself created).
 *
 * The refresh token goes in MONGOSHIELD_GDRIVE_TOKEN. The sign-in itself is the Drive
 * adapter's own (src/storage/gdrive-auth.ts), so the token is exactly what
 * `gdrive://` storage refreshes with. Google's device flow needs the app's
 * (non-confidential) client secret too; src/storage/oauth/apps.ts holds both.
 */

import {
  GDRIVE_TOKEN_SECRET,
  gdriveClientCredentials,
  loginGdrive,
} from "../../storage/gdrive-auth.ts";
import type { LoginContext, LoginProvider, LoginResult } from "./types.ts";

/** How long Google's device codes stay valid when it does not say (it does: ~30 min). */
const DEVICE_CODE_LIFETIME_MS = 30 * 60_000;

/** The Google Drive login provider. */
export const gdriveLoginProvider: LoginProvider = {
  id: "gdrive",
  displayName: "Google Drive",
  tokenEnv: GDRIVE_TOKEN_SECRET,
  flow: "device",
  async login(context: LoginContext): Promise<LoginResult> {
    const result = await loginGdrive({
      ...gdriveClientCredentials(context.env),
      signal: context.signal,
      ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      onPrompt: (prompt) =>
        context.show({
          kind: "device-code",
          userCode: prompt.userCode ?? "",
          verificationUri: prompt.verificationUrl,
          expiresAt: new Date(Date.now() + DEVICE_CODE_LIFETIME_MS),
        }),
    });
    return { refreshToken: result.refreshToken };
  },
};
