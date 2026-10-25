/**
 * The operator's version, from its package.json (inlined at build time by tsdown,
 * read at runtime when running from source).
 */

import packageJson from "../package.json" with { type: "json" };

/** The @mongoshield/operator version, e.g. 0.1.0. */
export const OPERATOR_VERSION: string = packageJson.version;
