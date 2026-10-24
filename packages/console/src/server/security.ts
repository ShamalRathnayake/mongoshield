/**
 * HTTP hardening that applies to every response or every state-changing request:
 * security headers, the same-origin check, and the JSON-only body rule.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, ConsoleSettings } from "./context.ts";
import { ConsoleError } from "./errors.ts";

/**
 * Content Security Policy for the UI and the API.
 *
 * - `script-src 'self'`: no inline scripts and no eval, so an injected `<script>`
 *   or `onerror=` attribute cannot run (the UI is a Vite bundle loaded from a file).
 * - `style-src 'self'`: stylesheets from files only. React's `style={…}` props are
 *   applied through the CSSOM, which CSP does not block.
 * - `frame-ancestors 'none'` (and X-Frame-Options) stop clickjacking.
 * - `connect-src 'self'`: the page can talk only to this server (API + SSE).
 * - `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`: close the
 *   usual CSP bypasses.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** HSTS for one year, including subdomains, once the console is known to be served over TLS. */
const HSTS = "max-age=31536000; includeSubDomains";

/** Sets the security headers on every response. */
export function securityHeaders(settings: ConsoleSettings): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (settings.https || new URL(c.req.url).protocol === "https:") {
      headers.set("Strict-Transport-Security", HSTS);
    }
    // API responses are per-user and may describe infrastructure: never cache them.
    if (new URL(c.req.url).pathname.startsWith("/api/")) {
      headers.set("Cache-Control", "no-store");
    }
  };
}

/** Methods that change state and therefore need the origin and CSRF checks. */
export function isStateChanging(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Refuses state-changing requests whose `Origin` header names another site.
 * Browsers send `Origin` on every cross-origin POST/PUT/DELETE, so this stops
 * cross-site requests even before the CSRF token is checked (defense in depth;
 * it also protects the login and setup forms, which have no session yet).
 * Requests without `Origin` (curl, server-to-server) are left to the CSRF check.
 */
export function sameOriginOnly(settings: ConsoleSettings): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isStateChanging(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedOrigin(c, origin, settings)) {
        throw new ConsoleError(
          403,
          "CONSOLE_BAD_ORIGIN",
          "Cross-site requests are not allowed.",
          "Open the console from its own address.",
        );
      }
    }
    await next();
  };
}

/** The request's own origin (Host header), or the configured public URL. */
function isAllowedOrigin(c: Context<AppEnv>, origin: string, settings: ConsoleSettings): boolean {
  if (settings.publicUrl !== undefined && origin === new URL(settings.publicUrl).origin)
    return true;
  const host = c.req.header("host");
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Reads a JSON request body. Only `application/json` is accepted: HTML forms
 * cannot send it cross-site without a CORS preflight (which this server never
 * approves), so this alone defeats classic form-based CSRF.
 */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new ConsoleError(
      415,
      "CONSOLE_UNSUPPORTED_MEDIA_TYPE",
      "Send the request body as application/json.",
    );
  }
  try {
    return await c.req.json();
  } catch {
    throw new ConsoleError(400, "CONSOLE_VALIDATION", "The request body is not valid JSON.");
  }
}
