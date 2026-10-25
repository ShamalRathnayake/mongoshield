/**
 * Recreating a collection's Atlas Search and Vector Search indexes on restore.
 *
 * Runs after the regular indexes. Search indexes are built asynchronously by
 * Atlas's search process: `createSearchIndexes` returns as soon as the definitions
 * are accepted, and the index becomes queryable minutes later. Restore does NOT
 * wait for that (it could take long and is not needed for the data to be correct);
 * it reports the indexes as "created; building in the background".
 *
 * Targets without Atlas Search (self-hosted servers, local test servers) cannot
 * have these indexes. Restoring a backup with search indexes there is still fine:
 * the documents and regular indexes are restored, and a warning names the search
 * indexes that were not created. The `skipSearchIndexes` option skips them on
 * purpose.
 */

import type { Document } from "mongodb";
import type { SearchIndexDefinition } from "../format/metadata.ts";
import type { Logger } from "../logger.ts";
import { isSearchIndexUnsupported, type SearchIndexListing } from "../mongo/search-indexes.ts";

/**
 * The part of a driver `Collection` used here. A real collection fits; unit tests
 * pass a small fake.
 */
export interface SearchIndexTarget extends SearchIndexListing {
  createSearchIndexes(
    descriptions: { name: string; type: SearchIndexDefinition["type"]; definition: Document }[],
  ): Promise<string[]>;
}

/** What happened to one collection's search indexes. */
export type SearchIndexOutcome =
  /** Sent to Atlas (`created`), or already present on the target (`existing`). */
  | { readonly status: "created"; readonly created: string[]; readonly existing: string[] }
  /** The target has no Atlas Search; nothing was created. */
  | { readonly status: "unsupported"; readonly notCreated: string[] };

/**
 * Creates the backed-up search indexes the target collection does not have yet
 * (matched by name: an index of the same name is kept as it is, like regular indexes
 * in the insert and upsert modes).
 *
 * @throws the driver error when the target supports search indexes but refuses a
 *   definition; the caller turns it into a restore failure naming the collection.
 */
export async function restoreSearchIndexes(
  collection: SearchIndexTarget,
  definitions: readonly SearchIndexDefinition[],
  context: { readonly ns: string; readonly logger: Logger },
): Promise<SearchIndexOutcome> {
  const names = definitions.map((definition) => definition.name);
  let existingNames: Set<string>;
  try {
    const existing = await collection.listSearchIndexes().toArray();
    existingNames = new Set(existing.map((index) => String(index.name)));
  } catch (error) {
    if (!isSearchIndexUnsupported(error)) throw error;
    return unsupported(names, context);
  }

  const missing = definitions.filter((definition) => !existingNames.has(definition.name));
  const existing = names.filter((name) => existingNames.has(name));
  if (missing.length > 0) {
    try {
      await collection.createSearchIndexes(
        missing.map((definition) => ({
          name: definition.name,
          type: definition.type,
          definition: definition.definition,
        })),
      );
    } catch (error) {
      if (!isSearchIndexUnsupported(error)) throw error;
      return unsupported(names, context);
    }
  }

  const created = missing.map((definition) => definition.name);
  if (created.length > 0) {
    context.logger.info("Search indexes created; building in the background", {
      ns: context.ns,
      indexes: created,
    });
  }
  if (existing.length > 0) {
    context.logger.info("Kept the target's search indexes of the same name", {
      ns: context.ns,
      indexes: existing,
    });
  }
  return { status: "created", created, existing };
}

/** Warns that the target cannot have search indexes, naming the ones left out. */
function unsupported(
  names: string[],
  context: { readonly ns: string; readonly logger: Logger },
): SearchIndexOutcome {
  context.logger.warn(
    "The target does not support Atlas Search indexes; they were not created (restore into Atlas to get them, or pass skipSearchIndexes)",
    { ns: context.ns, indexes: names },
  );
  return { status: "unsupported", notCreated: names };
}
