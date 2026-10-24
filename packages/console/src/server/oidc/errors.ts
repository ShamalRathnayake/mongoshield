/**
 * The error every OIDC step throws. Sign-in is a browser redirect flow, so the
 * route turns it into a redirect to the login page with `?sso_error=<code>`;
 * `detail` (what exactly was wrong) goes to the server log and the audit log only,
 * never to the browser, so a failed attempt teaches an attacker nothing.
 */

import type { OidcErrorCode } from "../../shared/api.ts";

/** A failed OIDC sign-in step. */
export class OidcError extends Error {
  override readonly name = "OidcError";
  readonly code: OidcErrorCode;

  /**
   * @param code what the UI shows (one of the `OidcErrorCode`s)
   * @param detail what went wrong, for operators; must not contain tokens or secrets
   */
  constructor(code: OidcErrorCode, detail: string) {
    super(detail);
    this.code = code;
  }
}
