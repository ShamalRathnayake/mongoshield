/**
 * Storage: where backups are written (S3-compatible buckets, GCS, Azure, SFTP or a path
 * inside the data volume).
 *
 * The add/edit dialog (storage-form.tsx) builds the location from a "Type" select and
 * per-type fields, and the credentials from named fields. Credentials are stored as
 * environment-style pairs (`AWS_ACCESS_KEY_ID=…`), encrypted and never returned;
 * editing shows only which keys are configured and keeps them unless replaced. The
 * Test button writes, reads and deletes a probe object and reports what the storage
 * supports, including object lock (needed for immutable backups).
 */

import { useState } from "react";
import type { StorageTestResult, StorageView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import {
  EmptyState,
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Time,
} from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { buildHref, segment } from "../router.ts";
import { StorageDialog } from "./storage-form.tsx";

/** Lists storage locations with add, edit, test and delete. */
export function StoragePage() {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const storage = useLoad("storage", (signal) =>
    client.call("GET /api/storage", undefined, { signal }),
  );
  const [editing, setEditing] = useState<StorageView | "new" | undefined>(undefined);
  const [testing, setTesting] = useState<
    { storage: StorageView; result?: StorageTestResult; error?: unknown } | undefined
  >(undefined);
  const [deleting, setDeleting] = useState<StorageView | undefined>(undefined);

  const test = async (location: StorageView) => {
    setTesting({ storage: location });
    try {
      setTesting({
        storage: location,
        result: await client.call("POST /api/storage/:id/test", undefined, {
          params: { id: location.id },
        }),
      });
    } catch (error) {
      setTesting({ storage: location, error });
    }
  };

  const remove = async (location: StorageView) => {
    try {
      await client.call("DELETE /api/storage/:id", undefined, { params: { id: location.id } });
      toast.show("success", `Removed "${location.name}". Its backups were not deleted.`);
      storage.reload();
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setDeleting(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Storage"
        description="Where backups are written. Credentials are stored encrypted and never shown again."
        actions={
          hasRole("admin") ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              Add storage
            </Button>
          ) : undefined
        }
      />
      {storage.error !== undefined ? (
        <ErrorNotice error={storage.error} onRetry={storage.reload} />
      ) : null}
      {storage.data === undefined ? (
        storage.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Storage locations"
          rows={storage.data}
          rowKey={(location) => location.id}
          empty={
            <EmptyState title="No storage yet">
              Add an S3 bucket, another provider or a local path to write backups to.
            </EmptyState>
          }
          columns={[
            {
              key: "name",
              header: "Name",
              sortValue: (location) => location.name,
              render: (location) => (
                <a href={buildHref(`/backups/${segment(location.id)}`)}>{location.name}</a>
              ),
            },
            { key: "url", header: "Location", render: (location) => <code>{location.url}</code> },
            {
              key: "credentials",
              header: "Credentials",
              hideOnNarrow: true,
              render: (location) =>
                location.credentials.configured ? (
                  <span title={location.credentials.preview}>Configured</span>
                ) : (
                  <span className="muted">None</span>
                ),
            },
            {
              key: "created",
              header: "Added",
              hideOnNarrow: true,
              render: (location) => <Time value={location.createdAt} relativeOnly />,
            },
            {
              key: "actions",
              header: <span className="visually-hidden">Actions</span>,
              align: "end",
              render: (location) => (
                <span className="row-actions">
                  {hasRole("operator") ? (
                    <Button
                      size="small"
                      onClick={() => void test(location)}
                      aria-label={`Test ${location.name}`}
                    >
                      Test
                    </Button>
                  ) : null}
                  {hasRole("admin") ? (
                    <>
                      <Button
                        size="small"
                        onClick={() => setEditing(location)}
                        aria-label={`Edit ${location.name}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        onClick={() => setDeleting(location)}
                        aria-label={`Remove ${location.name}`}
                      >
                        Remove
                      </Button>
                    </>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      )}

      {editing === undefined ? null : (
        <StorageDialog
          storage={editing === "new" ? undefined : editing}
          // The other locations' names, which this one may not take.
          takenNames={(storage.data ?? [])
            .filter((location) => editing === "new" || location.id !== editing.id)
            .map((location) => location.name)}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            storage.reload();
            toast.show("success", `Saved "${saved.name}". Testing it now…`);
            void test(saved);
          }}
        />
      )}

      <Dialog
        open={testing !== undefined}
        title={`Storage test: ${testing?.storage.name ?? ""}`}
        onClose={() => setTesting(undefined)}
        footer={<Button onClick={() => setTesting(undefined)}>Close</Button>}
      >
        {testing === undefined ? null : (
          <StorageTestReport result={testing.result} error={testing.error} />
        )}
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        title={`Remove "${deleting?.name ?? ""}"?`}
        description="The console forgets this location and its credentials. Backups already in it are not deleted."
        onClose={() => setDeleting(undefined)}
        footer={
          <>
            <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Remove storage
            </Button>
          </>
        }
      >
        <p>Plans that write here must be changed first.</p>
      </Dialog>
    </>
  );
}

/** What a storage test found. */
export function StorageTestReport(props: {
  result: StorageTestResult | undefined;
  error: unknown;
}) {
  if (props.error !== undefined)
    return <ErrorNotice error={props.error} title="The test could not run" />;
  const { result } = props;
  if (result === undefined)
    return <Loading label="Writing, reading and deleting a probe object…" />;
  if (!result.ok) {
    return (
      <Notice tone="danger" title="The storage test failed">
        <p>{result.error?.message ?? "The probe object could not be written."}</p>
        {result.error?.hint === undefined ? null : <p className="muted">{result.error.hint}</p>}
      </Notice>
    );
  }
  const yesNo = (value: boolean | undefined, yes: string, no: string) =>
    value ? <StatusBadge status="ok" label={yes} /> : <StatusBadge status="cancelled" label={no} />;
  return (
    <div className="stack-vertical">
      <p>
        <StatusBadge status="ok" label="Write, read and delete work" />
      </p>
      <KeyValueList
        items={[
          [
            "Conditional writes",
            yesNo(result.capabilities?.conditionalWrites, "Supported", "Not supported"),
          ],
          ["Range reads", yesNo(result.capabilities?.rangeReads, "Supported", "Not supported")],
          [
            "Object lock (immutable backups)",
            yesNo(result.capabilities?.objectLock, "Enabled", "Not enabled"),
          ],
        ]}
      />
    </div>
  );
}
