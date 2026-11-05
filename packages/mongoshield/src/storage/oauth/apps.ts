/**
 * The OAuth apps MongoShield ships for the drive providers, and how a user brings
 * their own. This is the ONE place that knows the client ids, endpoints, scopes and
 * environment variable names of each provider; the drive adapters and the
 * `mongoshield login` providers read them from here.
 *
 *   const client = resolveOAuthClient("gdrive");      // shipped id, or the env override
 *   const app = OAUTH_APPS.gdrive;                    // endpoints, scopes, env names
 *
 * Shipped client ids: MongoShield registers one app per provider (decided in the
 * accessible-storage design) and the maintainer fills in `clientId` (and Google's
 * `clientSecret`) below after registering it. Until then they are empty, and using
 * the provider without the env override fails with MS_CONFIG_INVALID and a hint.
 *
 *   provider   app type                                 what to register
 *   gdrive     Google "TVs and Limited Input devices"    drive.file scope (non-sensitive)
 *   dropbox    Dropbox "App folder" app, PKCE            files.* scopes, redirect
 *                                                        http://127.0.0.1/ (see the login provider)
 *
 * Bring your own: `MONGOSHIELD_<PROVIDER>_CLIENT_ID` (and `_CLIENT_SECRET` where the
 * provider issues one) override the shipped values, e.g. for a quota of your own on
 * Google. The refresh token from `mongoshield login <provider>` belongs in
 * `MONGOSHIELD_<PROVIDER>_TOKEN` (a repository secret in GitHub Actions).
 *
 * Google's "client secret" for installed and TV apps is not confidential (Google says
 * so: it ships inside every copy of the app), which is why it can live here. The
 * other two providers use public clients without a secret.
 */

import { MongoShieldError } from "../../errors.ts";

/** The providers with an OAuth app. Also the `mongoshield login <provider>` names. */
export type OAuthProviderId = "gdrive" | "dropbox";

/** Every provider id, in the order menus and help list them. */
export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = ["gdrive", "dropbox"];

/** Everything about one provider's OAuth app. */
export interface OAuthApp {
  readonly provider: OAuthProviderId;
  /** The provider's name for people: `"Google Drive"`. */
  readonly displayName: string;
  /** MongoShield's registered client id. Empty until the maintainer registers the app. */
  readonly clientId: string;
  /** The (non-confidential) client secret, for providers that issue one; else empty. */
  readonly clientSecret: string;
  /** `device`: RFC 8628 device code; `browser`: authorization code + PKCE on a loopback redirect. */
  readonly flow: "device" | "browser";
  readonly endpoints: {
    /** RFC 8628 device authorization endpoint (device flow only). */
    readonly deviceAuthorization?: string;
    /** Authorization endpoint the browser opens (browser flow only). */
    readonly authorization?: string;
    /** Token endpoint: code exchange, device polling and refreshes. */
    readonly token: string;
  };
  /** Scopes to ask for: the least the adapter needs. */
  readonly scopes: readonly string[];
  /** Extra parameters for the authorization request (e.g. Dropbox `token_access_type=offline`). */
  readonly authorizationParams?: Readonly<Record<string, string>>;
  /** Environment variable names. */
  readonly env: {
    /** Overrides `clientId`. */
    readonly clientId: string;
    /** Overrides `clientSecret`. */
    readonly clientSecret: string;
    /** Holds the refresh token `mongoshield login` printed. */
    readonly token: string;
  };
}

/** The `MONGOSHIELD_<PROVIDER>_…` variable names of a provider. */
function envNames(provider: OAuthProviderId): OAuthApp["env"] {
  const prefix = `MONGOSHIELD_${provider.toUpperCase()}`;
  return {
    clientId: `${prefix}_CLIENT_ID`,
    clientSecret: `${prefix}_CLIENT_SECRET`,
    token: `${prefix}_TOKEN`,
  };
}

/**
 * The shipped apps. Endpoints and scopes were checked against each provider's
 * documentation on 4 November 2026; the adapter releases confirm them against the
 * real services.
 */
export const OAUTH_APPS: Readonly<Record<OAuthProviderId, OAuthApp>> = {
  gdrive: {
    provider: "gdrive",
    displayName: "Google Drive",
    // MongoShield's Google OAuth client ("MongoShield CLI", TV / limited input), in the
    // Google Cloud project `mongoshield`.
    clientId: "795590775448-hp5uifobp96siel0278b6a4k6dl5ku8o.apps.googleusercontent.com",
    // Not confidential for this app type (see the header comment).
    clientSecret: "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",
    flow: "device",
    endpoints: {
      deviceAuthorization: "https://oauth2.googleapis.com/device/code",
      token: "https://oauth2.googleapis.com/token",
    },
    // Only the files MongoShield itself created (non-sensitive, no security review).
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    env: envNames("gdrive"),
  },

  dropbox: {
    provider: "dropbox",
    displayName: "Dropbox",
    // The app key of MongoShield's Dropbox app ("MongoShield", App folder access, PKCE,
    // redirects http://127.0.0.1:53917/callback and :53918/callback).
    clientId: "4eztt2dgf90i279",
    clientSecret: "",
    // Dropbox has no device flow: a local browser redirect with PKCE.
    flow: "browser",
    endpoints: {
      authorization: "https://www.dropbox.com/oauth2/authorize",
      token: "https://api.dropboxapi.com/oauth2/token",
    },
    // The same least-privilege set as DROPBOX_SCOPES (dropbox-auth.ts), which the
    // login actually requests; files.metadata.write is not needed.
    scopes: [
      "account_info.read",
      "files.content.read",
      "files.content.write",
      "files.metadata.read",
    ],
    // "offline" asks for a refresh token instead of a short-lived access token only.
    authorizationParams: { token_access_type: "offline" },
    env: envNames("dropbox"),
  },
};

/** The client credentials to use for a provider. */
export interface OAuthClient {
  readonly clientId: string;
  /** Present when the provider issues one (Google) or the user set one. */
  readonly clientSecret?: string;
  /** Where the id came from, for messages: MongoShield's app or the user's own. */
  readonly source: "shipped" | "environment";
}

/** Each provider's guide, under docs/guides/ (named for people, not by scheme). */
const GUIDES: Readonly<Record<OAuthProviderId, string>> = {
  gdrive: "google-drive.md",
  dropbox: "dropbox.md",
};

/**
 * The client for `provider`: `MONGOSHIELD_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` when
 * set, else the shipped app.
 *
 * @throws MS_CONFIG_INVALID when neither has a client id (the shipped one is not
 *   filled in yet), with a hint naming the variables to set.
 */
export function resolveOAuthClient(
  provider: OAuthProviderId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): OAuthClient {
  const app = OAUTH_APPS[provider];
  const ownId = env[app.env.clientId]?.trim();
  if (ownId) {
    const ownSecret = env[app.env.clientSecret]?.trim();
    return {
      clientId: ownId,
      ...(ownSecret ? { clientSecret: ownSecret } : {}),
      source: "environment",
    };
  }
  if (app.clientId === "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `This release of MongoShield has no ${app.displayName} app built in yet.`,
      {
        hint:
          `Register your own ${app.displayName} OAuth app and set ${app.env.clientId}` +
          (app.flow === "device" && provider === "gdrive" ? ` and ${app.env.clientSecret}` : "") +
          `, or use a release that ships one. See docs/guides/${GUIDES[provider]}.`,
        details: { provider },
      },
    );
  }
  return {
    clientId: app.clientId,
    ...(app.clientSecret === "" ? {} : { clientSecret: app.clientSecret }),
    source: "shipped",
  };
}

/**
 * Environment variables that hold OAuth secrets (refresh tokens and client secrets),
 * so the CLI can keep their values out of every line it prints.
 */
export function oauthSecretEnvNames(): string[] {
  return OAUTH_PROVIDER_IDS.flatMap((provider) => [
    OAUTH_APPS[provider].env.token,
    OAUTH_APPS[provider].env.clientSecret,
  ]);
}
