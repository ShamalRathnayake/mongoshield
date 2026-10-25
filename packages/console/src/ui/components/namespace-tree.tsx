/**
 * NamespaceTree: the databases and collections of a connection, with document and index
 * counts. Used on the connection page (with "used by plans") and in the plan editor
 * (with a live "included / excluded" marker for the current patterns).
 *
 * Each database is a native `<details>` element, which is keyboard accessible and
 * expandable without any script.
 */

import type { ReactNode } from "react";
import type { DatabaseNode } from "../../shared/api.ts";
import { formatNumber, plural } from "../format.ts";

/** Props for `NamespaceTree`. */
export interface NamespaceTreeProps {
  readonly tree: readonly DatabaseNode[];
  /** When set, each collection shows whether it is selected. */
  readonly isSelected?: (ns: string) => boolean;
  /** Extra cell per collection, e.g. the plans that back it up. */
  readonly annotate?: (ns: string) => ReactNode;
  readonly annotateHeader?: string;
}

/** A database → collection tree with counts. */
export function NamespaceTree(props: NamespaceTreeProps) {
  const { isSelected, annotate } = props;
  if (props.tree.length === 0)
    return <p className="muted">This connection has no user databases.</p>;
  return (
    <div className="namespace-tree">
      {props.tree.map((database) => {
        const selectedCount = isSelected
          ? database.collections.filter((collection) =>
              isSelected(`${database.name}.${collection.name}`),
            ).length
          : undefined;
        const totalDocuments = database.collections.reduce(
          (sum, collection) => sum + collection.estimatedDocuments,
          0,
        );
        return (
          <details key={database.name} className="namespace-database" open>
            <summary>
              <span className="namespace-name">{database.name}</span>
              <span className="muted">
                {plural(database.collections.length, "collection")} · {formatNumber(totalDocuments)}{" "}
                documents
                {selectedCount === undefined ? "" : ` · ${selectedCount} selected`}
              </span>
            </summary>
            <table className="table table-compact">
              <caption className="visually-hidden">Collections in {database.name}</caption>
              <thead>
                <tr>
                  {isSelected ? <th scope="col">Backed up</th> : null}
                  <th scope="col">Collection</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="align-end">
                    Documents (est.)
                  </th>
                  <th scope="col" className="align-end">
                    Indexes
                  </th>
                  {annotate ? <th scope="col">{props.annotateHeader ?? "Notes"}</th> : null}
                </tr>
              </thead>
              <tbody>
                {database.collections.map((collection) => {
                  const ns = `${database.name}.${collection.name}`;
                  const selected = isSelected?.(ns);
                  return (
                    <tr key={ns} className={selected === false ? "row-dimmed" : undefined}>
                      {selected === undefined ? null : (
                        <td>
                          <span className={selected ? "marker marker-in" : "marker marker-out"}>
                            <span aria-hidden="true">{selected ? "✓ " : "– "}</span>
                            {selected ? "Included" : "Excluded"}
                          </span>
                        </td>
                      )}
                      <td className="namespace-name">{collection.name}</td>
                      <td>{collection.type}</td>
                      <td className="align-end numeric">
                        {formatNumber(collection.estimatedDocuments)}
                      </td>
                      <td className="align-end numeric">{formatNumber(collection.indexes)}</td>
                      {annotate ? <td>{annotate(ns)}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        );
      })}
    </div>
  );
}
