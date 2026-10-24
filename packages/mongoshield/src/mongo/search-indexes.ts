/**
 * Atlas Search and Atlas Vector Search index definitions.
 *
 * These indexes live outside the regular index catalog: `listIndexes` does not show
 * them and mongodump does not back them up. They are listed with the
 * `$listSearchIndexes` stage (the driver's `collection.listSearchIndexes()`) and
 * created with `createSearchIndexes`, both only available where a search process
 * (`mongot`) runs, which in practice means Atlas.
 *
 * Every other server answers with an error, whose code depends on the version (see
 * `SEARCH_UNSUPPORTED_CODES`). Discovery treats that as "this collection has no
 * search indexes" without a word, so a backup never fails or warns because the
 * source is not Atlas. Restore uses the same check to skip them with a warning.
 */

import { type Document, MongoServerError } from "mongodb";
import { isSearchIndexType, type SearchIndexDefinition } from "../format/metadata.ts";
import type { Logger } from "../logger.ts";

/**
 * The part of a driver `Collection` that lists search indexes. A real collection
 * fits; tests pass a small fake.
 */
export interface SearchIndexListing {
  listSearchIndexes(): { toArray(): Promise<Document[]> };
}

/**
 * Server error codes meaning "search indexes are not available here":
 *
 * - 6047401 `$listSearchIndexes stage is only allowed on MongoDB Atlas` (6.0.7+ / 7.0
 *   community and enterprise servers)
 * - 31082 SearchNotEnabled: the stage exists but no search process is configured
 *   (8.x community servers without `mongot`)
 * - 40324 `Unrecognized pipeline stage name` (servers before the stage existed)
 * - 59 CommandNotFound: `createSearchIndexes` is not a command on this server
 * - 115 CommandNotSupported
 */
const SEARCH_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([6047401, 31082, 40324, 59, 115]);

/** True when `error` says the server does not support search indexes at all. */
export function isSearchIndexUnsupported(error: unknown): boolean {
  if (!(error instanceof MongoServerError)) return false;
  if (typeof error.code === "number" && SEARCH_UNSUPPORTED_CODES.has(error.code)) return true;
  return error.codeName === "SearchNotEnabled";
}

/**
 * Whether the server supports search indexes, learned from the first collection
 * asked: `undefined` until then. Shared by all collections of one discovery run,
 * so a server without search is asked once, not once per collection.
 */
export interface SearchIndexSupport {
  supported: boolean | undefined;
}

/**
 * Lists a collection's search index definitions, without status fields.
 *
 * Never throws: on a server without search indexes the result is `[]` (and
 * `support.supported` becomes false, so later calls return `[]` at once); any other
 * failure, such as a missing `listSearchIndexes` privilege, is logged as a warning
 * and also gives `[]`, because a backup must not fail over these optional indexes.
 */
export async function listSearchIndexDefinitions(
  collection: SearchIndexListing,
  context: { readonly ns: string; readonly support: SearchIndexSupport; readonly logger: Logger },
): Promise<SearchIndexDefinition[]> {
  if (context.support.supported === false) return [];
  let listed: Document[];
  try {
    listed = await collection.listSearchIndexes().toArray();
  } catch (error) {
    if (isSearchIndexUnsupported(error)) {
      context.support.supported = false;
      context.logger.debug("The server has no Atlas Search; no search indexes to back up");
      return [];
    }
    context.logger.warn(
      "Could not list the search indexes of a collection; they are not backed up",
      {
        ns: context.ns,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }
  context.support.supported = true;

  const definitions: SearchIndexDefinition[] = [];
  for (const index of listed) {
    const definition = toSearchIndexDefinition(index);
    if (definition === undefined) {
      context.logger.warn("Skipping a search index that cannot be recreated", {
        ns: context.ns,
        index: typeof index.name === "string" ? index.name : "(unnamed)",
        type: String(index.type),
      });
      continue;
    }
    definitions.push(definition);
  }
  return definitions;
}

/**
 * Turns one `$listSearchIndexes` result into a definition, or `undefined` when it
 * lacks a name or definition or has an unknown type.
 *
 * The definition is `latestDefinition`: the one the user last submitted, which is
 * what an update in progress will converge to. Older Atlas versions without a
 * `type` field only had `search` indexes.
 */
export function toSearchIndexDefinition(index: Document): SearchIndexDefinition | undefined {
  const name: unknown = index.name;
  const definition: unknown = index.latestDefinition ?? index.definition;
  const type: unknown = index.type ?? "search";
  if (typeof name !== "string" || name === "" || !isDocument(definition)) return undefined;
  if (!isSearchIndexType(type)) return undefined;
  return { name, type, definition };
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
