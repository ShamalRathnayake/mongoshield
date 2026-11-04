/**
 * The storage-scheme registry: which factory turns a `<scheme>://…` URL into a
 * `StorageAdapter`. `resolveStorage` (resolve.ts) asks it for every URL.
 *
 *   import { registerStorageScheme } from "mongoshield";
 *
 *   registerStorageScheme("pcloud", ({ parsed, env }) =>
 *     pcloudStorage({ folder: parsed.pathname, token: env.PCLOUD_TOKEN }),
 *   );
 *   // mongoshield backup --storage pcloud://backups/prod
 *
 * Two kinds of registration live here:
 *
 * - First-party schemes (`file`, `s3`, `b2`, `r2`, `gs`, `az`, `sftp`, `memory`, see
 *   schemes.ts) are built into this copy of the package. They cannot be registered
 *   again by accident, only replaced on purpose (`{ replace: true }`).
 * - Everything registered with `registerStorageScheme` (community packages, a test's
 *   fake) lives in one map shared by every copy of mongoshield in the process.
 *
 * Why shared through `globalThis`: a community package imports `mongoshield` from its
 * own node_modules, and the CLI loads config files through jiti without a module
 * cache, so the code that registers a scheme and the code that resolves the URL can
 * be different module instances, even different installed copies. A map stored under
 * a well-known `Symbol.for` key is the one place they all see. First-party schemes
 * are deliberately NOT shared that way, so each copy resolves its own adapters.
 */

import { MongoShieldError } from "../errors.ts";
import { FIRST_PARTY_STORAGE_SCHEMES, SUPPORTED_STORAGE_SCHEMES } from "./schemes.ts";
import type { StorageAdapter } from "./types.ts";

/** The environment a factory reads credentials from (`process.env` unless injected). */
export type StorageEnvironment = Readonly<Record<string, string | undefined>>;

/** Everything a scheme factory receives about the URL it should open. */
export interface StorageSchemeContext {
  /** The URL exactly as given, e.g. `pcloud://backups/prod?region=eu`. May hold no secrets. */
  readonly url: string;
  /**
   * The URL parsed with the WHATWG `URL` parser. `hostname` is the part after `://`
   * up to the first `/` (a bucket, an account, a folder), `pathname` the rest.
   */
  readonly parsed: URL;
  /** The scheme, lower-cased and without `://`, e.g. `"pcloud"`. */
  readonly scheme: string;
  /**
   * Where credentials come from: `process.env`, or what the caller passed to
   * `resolveStorage(url, { env })` (tests, multi-tenant hosts). Read tokens from
   * here, never from the URL.
   */
  readonly env: StorageEnvironment;
}

/**
 * Creates the adapter for one URL. May be async, e.g. to import the adapter's module
 * lazily so its code loads only when the scheme is used. Throw `MongoShieldError`
 * `MS_CONFIG_INVALID` (with a hint) for a malformed URL or missing credentials.
 */
export type StorageSchemeFactory = (
  context: StorageSchemeContext,
) => StorageAdapter | Promise<StorageAdapter>;

/** Options for {@link registerStorageScheme}. */
export interface RegisterStorageSchemeOptions {
  /**
   * Replace an existing registration of the same scheme (first-party or not) instead
   * of failing. Meant for tests and for deliberately overriding an adapter.
   */
  readonly replace?: boolean;
  /**
   * Who registers the scheme, normally the package name (`"mongoshield-pcloud"`). A
   * second registration by the same owner replaces the first silently: that is the
   * same package evaluated again (the CLI loads config files without a module cache,
   * so a package imported there runs once per load). A different owner still fails.
   */
  readonly owner?: string;
}

/** Removes a registration again (see {@link registerStorageScheme}). */
export type UnregisterStorageScheme = () => void;

/** Scheme names: a letter, then letters, digits, `+`, `-` or `.` (RFC 3986 §3.1). */
const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/** The key of the process-wide map of registered schemes (see the file header). */
const REGISTRY_KEY = Symbol.for("mongoshield.storage-schemes.v1");

/** One registration made through {@link registerStorageScheme}. */
interface Registration {
  readonly factory: StorageSchemeFactory;
  readonly owner: string | undefined;
  /** The registration this one replaced, put back when this one is undone. */
  readonly replaced: Registration | undefined;
  /** Set once undone, so it is never put back by a later undo of its replacement. */
  withdrawn: boolean;
}

/** The process-wide map, created by whichever copy of mongoshield gets here first. */
function sharedRegistrations(): Map<string, Registration> {
  const holder = globalThis as { [REGISTRY_KEY]?: Map<string, Registration> };
  let registrations = holder[REGISTRY_KEY];
  if (registrations === undefined) {
    registrations = new Map();
    holder[REGISTRY_KEY] = registrations;
  }
  return registrations;
}

/**
 * Makes `resolveStorage` (and so the CLI, config files and the console) understand
 * `<scheme>://…` URLs, by calling `factory` for each one.
 *
 * Registering a scheme that already exists (one of the first-party schemes, or one a
 * package registered earlier) fails with `MS_CONFIG_INVALID`, because two packages
 * claiming the same scheme would silently send backups to the wrong place. Pass
 * `{ replace: true }` to replace it on purpose. Packages should pass their name as
 * `owner`, so being evaluated twice in one process re-registers instead of failing.
 *
 * Community packages register their scheme when they are imported; in a config file
 * a side-effect import is enough:
 *
 *   // in mongoshield-pcloud:
 *   registerStorageScheme("pcloud", factory, { owner: "mongoshield-pcloud" });
 *   // in mongoshield.config.ts:
 *   import "mongoshield-pcloud";       // registers pcloud://
 *   export default defineConfig({ storage: "pcloud://backups" });
 *
 * @param scheme the scheme without `://`, e.g. `"pcloud"`. Case-insensitive.
 * @returns a function that undoes this registration (and puts back what it replaced).
 * @throws MS_CONFIG_INVALID for an invalid scheme name or a duplicate registration.
 */
export function registerStorageScheme(
  scheme: string,
  factory: StorageSchemeFactory,
  options: RegisterStorageSchemeOptions = {},
): UnregisterStorageScheme {
  const name = normalizeSchemeName(scheme);
  if (typeof factory !== "function") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The factory for "${name}://" must be a function.`,
    );
  }
  const registrations = sharedRegistrations();
  const previous = registrations.get(name);
  const sameOwner =
    previous !== undefined && options.owner !== undefined && previous.owner === options.owner;
  // Taken: by an earlier registration of another owner, or (with no registration yet)
  // by the first-party scheme of the same name.
  const taken = previous === undefined ? isFirstParty(name) : !sameOwner;
  if (options.replace !== true && taken) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The storage scheme "${name}://" is already registered.`,
      {
        hint: isFirstParty(name)
          ? `${name}:// is built into MongoShield. Pick another scheme name, or pass { replace: true } to override it on purpose.`
          : "Two packages register the same scheme. Remove one of them, or pass { replace: true } to override it on purpose.",
      },
    );
  }
  const registration: Registration = {
    factory,
    owner: options.owner,
    // A re-registration by the same owner takes the old one's place for good: undoing
    // it must not bring back the stale factory of the earlier evaluation.
    replaced: sameOwner ? previous?.replaced : previous,
    withdrawn: false,
  };
  registrations.set(name, registration);

  return () => {
    registration.withdrawn = true;
    // A registration that was replaced since stays replaced; it is only marked, so
    // undoing its replacement later skips it.
    if (registrations.get(name) !== registration) return;
    let restore = registration.replaced;
    while (restore?.withdrawn === true) restore = restore.replaced;
    if (restore === undefined) registrations.delete(name);
    else registrations.set(name, restore);
  };
}

/**
 * The factory for a scheme: a registered one first (so `{ replace: true }` wins over
 * a first-party scheme), else the first-party one, else `undefined`.
 */
export function storageSchemeFactory(scheme: string): StorageSchemeFactory | undefined {
  const name = scheme.toLowerCase();
  const registered = sharedRegistrations().get(name);
  if (registered !== undefined) return registered.factory;
  return isFirstParty(name) ? FIRST_PARTY_STORAGE_SCHEMES[name] : undefined;
}

/** True when `resolveStorage` can open `<scheme>://` URLs. Case-insensitive. */
export function isStorageSchemeRegistered(scheme: string): boolean {
  return storageSchemeFactory(scheme) !== undefined;
}

/**
 * Every scheme `resolveStorage` understands right now: the first-party ones in their
 * documented order, then registered ones in the order they were registered.
 */
export function registeredStorageSchemes(): string[] {
  const schemes: string[] = [...SUPPORTED_STORAGE_SCHEMES];
  for (const name of sharedRegistrations().keys()) {
    if (!schemes.includes(name)) schemes.push(name);
  }
  return schemes;
}

/** True for the schemes built into this copy of the package (schemes.ts). */
function isFirstParty(name: string): name is keyof typeof FIRST_PARTY_STORAGE_SCHEMES {
  return Object.hasOwn(FIRST_PARTY_STORAGE_SCHEMES, name);
}

/** `"PCloud"` → `"pcloud"`; `"pcloud://"` and other non-names fail. */
function normalizeSchemeName(scheme: string): string {
  const name = typeof scheme === "string" ? scheme.toLowerCase() : "";
  if (!SCHEME_NAME.test(name)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid storage scheme name "${scheme}".`, {
      hint: 'Use letters, digits, "+", "-" or "." starting with a letter, without "://", e.g. "pcloud".',
    });
  }
  return name;
}
