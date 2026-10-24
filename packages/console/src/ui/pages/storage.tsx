/**
 * Storage: where backups are written (S3-compatible buckets, GCS, Azure, SFTP or a path
 * inside the data volume).
 *
 * Credentials are environment-style pairs (`AWS_ACCESS_KEY_ID=…`), stored encrypted and
 * never returned; editing shows only which keys are configured, and leaving the
 * credentials box empty keeps them. The Test button writes, reads and deletes a probe
 * object and reports what the storage supports, including object lock (needed for
 * immutable backups).
 */

import { type FormEvent, useState } from "react";
import type { StorageInput, StorageTestResult, StorageView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import { TextAreaField, TextField } from "../components/field.tsx";
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

/**
 * Parses `KEY=value` lines into credentials. Returns an error message for a bad line.
 * Blank lines and `#` comments are ignored so people can paste a .env snippet.
 */
export function parseCredentials(text: string): Record<string, string> | string {
  const credentials: Record<string, string> = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return `Line ${index + 1} is not KEY=value.`;
    credentials[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return credentials;
}

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

/** Add/edit form for a storage location. Credentials are write-only. */
function StorageDialog(props: {
  storage: StorageView | undefined;
  onClose: () => void;
  onSaved: (storage: StorageView) => void;
}) {
  const client = useApi();
  const existing = props.storage;
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [credentialsText, setCredentialsText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const parsedCredentials = parseCredentials(credentialsText);
  const errors = {
    name: name.trim() === "" ? "Give the storage a name, e.g. “S3 primary”." : undefined,
    url:
      url.trim() === ""
        ? "Enter a URL such as s3://bucket/prefix/ or a path like /data/backups."
        : undefined,
    credentials: typeof parsedCredentials === "string" ? parsedCredentials : undefined,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (
      Object.values(errors).some((message) => message !== undefined) ||
      typeof parsedCredentials === "string"
    )
      return;
    setBusy(true);
    setError(undefined);
    // Empty credentials on edit = keep the stored ones.
    const keep = credentialsText.trim() === "" && existing !== undefined;
    const input: StorageInput = {
      name: name.trim(),
      url: url.trim(),
      ...(keep ? {} : { credentials: parsedCredentials }),
    };
    try {
      const saved =
        existing === undefined
          ? await client.call("POST /api/storage", input)
          : await client.call("PUT /api/storage/:id", input, { params: { id: existing.id } });
      setCredentialsText("");
      props.onSaved(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={existing === undefined ? "Add storage" : `Edit "${existing.name}"`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="storage-form" busy={busy}>
            {existing === undefined ? "Add and test" : "Save and test"}
          </Button>
        </>
      }
    >
      <form id="storage-form" onSubmit={submit} noValidate className="form">
        <TextField
          label="Name"
          value={name}
          onValue={setName}
          data-autofocus
          error={submitted ? errors.name : undefined}
        />
        <TextField
          label="Location"
          value={url}
          onValue={setUrl}
          spellCheck={false}
          placeholder="s3://acme-backups/prod/"
          hint="s3://, gs://, az://, sftp:// or a path inside the console's data volume."
          error={submitted ? errors.url : undefined}
        />
        <TextAreaField
          label="Credentials"
          value={credentialsText}
          onValue={setCredentialsText}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder={"AWS_ACCESS_KEY_ID=…\nAWS_SECRET_ACCESS_KEY=…"}
          hint={
            existing?.credentials.configured ? (
              <>
                Stored: {existing.credentials.preview ?? "configured"}. Leave empty to keep them;
                anything typed here replaces all of them.
              </>
            ) : (
              "One KEY=value per line, stored encrypted. Leave empty to use the console's environment (e.g. an IAM role)."
            )
          }
          error={submitted ? errors.credentials : undefined}
        />
        {error === undefined ? null : <ErrorNotice error={error} title="Could not save" />}
      </form>
    </Dialog>
  );
}
