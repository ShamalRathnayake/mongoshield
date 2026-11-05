/**
 * The contract between `mongoshield login <provider>` (commands/login.ts) and the
 * provider modules (gdrive.ts, dropbox.ts): a provider runs its OAuth
 * flow and returns the long-lived refresh token; the command shows the person what
 * to do, prints the token once and says which secret it belongs in.
 *
 * Providers never print. They describe what the person must do through
 * `context.show(...)`, and the command decides how that looks (and keeps it off
 * stdout, which carries only the token).
 */

/** What the person has to do to finish signing in. */
export type LoginInstructions =
  | {
      /** Device flow: type `userCode` at `verificationUri`, on any device. */
      readonly kind: "device-code";
      readonly userCode: string;
      readonly verificationUri: string;
      /** The same page with the code filled in, when the provider offers one. */
      readonly verificationUriComplete?: string;
      readonly expiresAt: Date;
    }
  | {
      /** Browser flow: open `url` in a browser on this machine. */
      readonly kind: "open-url";
      readonly url: string;
      /**
       * True when the browser will not come back to this machine by itself (over SSH,
       * in a Codespace, or no free local port): the provider then shows a code to paste
       * into `readCode`.
       */
      readonly paste?: boolean;
    };

/** What a provider's `login` receives. */
export interface LoginContext {
  /** Where to read `MONGOSHIELD_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` overrides. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted on Ctrl-C. */
  readonly signal: AbortSignal;
  /** Shows the person what to do (printed on stderr by the command). */
  readonly show: (instructions: LoginInstructions) => void;
  /** A fixed loopback port for browser flows (`--port`); random when absent. */
  readonly port?: number;
  /** The `fetch` to use; tests inject one. */
  readonly fetch?: typeof fetch;
  /**
   * Reads one line the person pastes (a code, or the URL the browser landed on). The
   * signal fires once the answer is no longer needed. Absent without a terminal.
   */
  readonly readCode?: (options: { readonly signal: AbortSignal }) => Promise<string>;
}

/** What a successful login produces. */
export interface LoginResult {
  /** The long-lived token adapters refresh with. A secret: printed once, never logged. */
  readonly refreshToken: string;
  /** Who signed in (an e-mail or display name), when the provider says cheaply. */
  readonly account?: string;
}

/** One provider of `mongoshield login`. */
export interface LoginProvider {
  /** The name on the command line and in storage URLs: `gdrive`, `dropbox`. */
  readonly id: string;
  /** For people: `"Google Drive"`. */
  readonly displayName: string;
  /** The environment variable / repository secret the token belongs in: `MONGOSHIELD_GDRIVE_TOKEN`. */
  readonly tokenEnv: string;
  /** How the person signs in, for help text: on any device, or in a local browser. */
  readonly flow: "device" | "browser";
  /** Runs the OAuth flow to the end. Throws MongoShieldError on failure. */
  login(context: LoginContext): Promise<LoginResult>;
}
