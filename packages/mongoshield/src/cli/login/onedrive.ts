/**
 * `mongoshield login onedrive`: OneDrive, with the device flow (a code to approve on
 * any device) and only the app-folder scope (`Files.ReadWrite.AppFolder`).
 *
 * The sign-in is the OneDrive adapter's own (src/storage/onedrive-auth.ts). Its
 * result is an `onedrive1.` envelope, not a bare refresh token: it records when the
 * sign-in was issued, which the adapter needs for Microsoft's 90-day limit and the
 * day-75 warning (docs/guides/onedrive.md). It goes in MONGOSHIELD_ONEDRIVE_TOKEN.
 *
 * `--business` (context.business) also allows work and school accounts. Experimental.
 */

import {
  loginOneDrive,
  ONEDRIVE_SECRET_NAME,
  resolveOneDriveClient,
} from "../../storage/onedrive-auth.ts";
import type { LoginContext, LoginProvider, LoginResult } from "./types.ts";

/** Microsoft's device codes stay valid for about 15 minutes. */
const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;

/** The OneDrive login provider. */
export const onedriveLoginProvider: LoginProvider = {
  id: "onedrive",
  displayName: "OneDrive",
  tokenEnv: ONEDRIVE_SECRET_NAME,
  flow: "device",
  async login(context: LoginContext): Promise<LoginResult> {
    const client = resolveOneDriveClient({ ...context.env });
    const result = await loginOneDrive({
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      signal: context.signal,
      ...(context.business === true ? { business: true } : {}),
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
