/**
 * Connections: the MongoDB deployments the console backs up from and restores into.
 *
 * The connection string is write-only. The API never returns it, only a redacted
 * preview (`mongodb+srv://backup:***@host`), so the edit dialog starts with an empty
 * URI field and leaving it empty keeps the stored one. "Production" connections need
 * an admin and a typed confirmation before anything is restored into them.
 */

import { type FormEvent, useState } from "react";
import type { ConnectionInput, ConnectionTestResult, ConnectionView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import { CheckboxField, TextField } from "../components/field.tsx";
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
import { buildHref, navigate, segment } from "../router.ts";

/** Lists connections with add, edit, test and delete. */
export function ConnectionsPage() {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const connections = useLoad("connections", (signal) =>
    client.call("GET /api/connections", undefined, { signal }),
  );
  const [editing, setEditing] = useState<ConnectionView | "new" | undefined>(undefined);
  const [testing, setTesting] = useState<
    { connection: ConnectionView; result?: ConnectionTestResult; error?: unknown } | undefined
  >(undefined);
  const [deleting, setDeleting] = useState<ConnectionView | undefined>(undefined);

  const test = async (connection: ConnectionView) => {
    setTesting({ connection });
    try {
      const result = await client.call("POST /api/connections/:id/test", undefined, {
        params: { id: connection.id },
      });
      setTesting({ connection, result });
    } catch (error) {
      setTesting({ connection, error });
    }
  };

  const remove = async (connection: ConnectionView) => {
    try {
      await client.call("DELETE /api/connections/:id", undefined, {
        params: { id: connection.id },
      });
      toast.show("success", `Deleted "${connection.name}".`);
      connections.reload();
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setDeleting(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Connections"
        description="MongoDB deployments to back up from and restore into. Connection strings are stored encrypted and never shown again."
        actions={
          hasRole("admin") ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              Add connection
            </Button>
          ) : undefined
        }
      />
      {connections.error !== undefined ? (
        <ErrorNotice error={connections.error} onRetry={connections.reload} />
      ) : null}
      {connections.data === undefined ? (
        connections.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Connections"
          rows={connections.data}
          rowKey={(connection) => connection.id}
          onRowActivate={(connection) => navigate(`/connections/${segment(connection.id)}`)}
          empty={
            <EmptyState title="No connections yet">
              Add the MongoDB deployment you want to back up. A read-only user with the{" "}
              <code>backup</code> role is enough for backups.
            </EmptyState>
          }
          columns={[
            {
              key: "name",
              header: "Name",
              sortValue: (connection) => connection.name,
              render: (connection) => (
                <span className="stack">
                  <a href={buildHref(`/connections/${segment(connection.id)}`)}>
                    {connection.name}
                  </a>
                  {connection.production ? <StatusBadge status="production" /> : null}
                </span>
              ),
            },
            {
              key: "uri",
              header: "Connection string",
              render: (connection) => (
                <code className="secret-preview">
                  {connection.uri.preview ?? (connection.uri.configured ? "configured" : "not set")}
                </code>
              ),
            },
            {
              key: "created",
              header: "Added",
              hideOnNarrow: true,
              sortValue: (connection) => connection.createdAt,
              render: (connection) => <Time value={connection.createdAt} relativeOnly />,
            },
            {
              key: "actions",
              header: <span className="visually-hidden">Actions</span>,
              align: "end",
              render: (connection) => (
                <span className="row-actions">
                  {hasRole("operator") ? (
                    <Button
                      size="small"
                      onClick={() => void test(connection)}
                      aria-label={`Test ${connection.name}`}
                    >
                      Test
                    </Button>
                  ) : null}
                  {hasRole("admin") ? (
                    <>
                      <Button
                        size="small"
                        onClick={() => setEditing(connection)}
                        aria-label={`Edit ${connection.name}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        onClick={() => setDeleting(connection)}
                        aria-label={`Delete ${connection.name}`}
                      >
                        Delete
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
        <ConnectionDialog
          connection={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            connections.reload();
            toast.show("success", `Saved "${saved.name}". Testing it now…`);
            void test(saved);
          }}
        />
      )}

      <Dialog
        open={testing !== undefined}
        title={`Connection test: ${testing?.connection.name ?? ""}`}
        onClose={() => setTesting(undefined)}
        footer={<Button onClick={() => setTesting(undefined)}>Close</Button>}
      >
        {testing === undefined ? null : (
          <ConnectionTestReport result={testing.result} error={testing.error} />
        )}
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        title={`Delete "${deleting?.name ?? ""}"?`}
        description="Backups made from this connection stay in storage. Plans that use it must be changed first."
        onClose={() => setDeleting(undefined)}
        footer={
          <>
            <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete connection
            </Button>
          </>
        }
      >
        <p>The stored connection string is deleted and cannot be recovered.</p>
      </Dialog>
    </>
  );
}

/** Shows what a connection test found: reachability, topology, version and missing privileges. */
export function ConnectionTestReport(props: {
  result: ConnectionTestResult | undefined;
  error: unknown;
}) {
  if (props.error !== undefined)
    return <ErrorNotice error={props.error} title="The test could not run" />;
  const { result } = props;
  if (result === undefined) return <Loading label="Connecting and checking privileges…" />;
  if (!result.ok) {
    return (
      <Notice tone="danger" title="Could not connect">
        <p>{result.error?.message ?? "The connection failed."}</p>
        {result.error?.hint === undefined ? null : <p className="muted">{result.error.hint}</p>}
      </Notice>
    );
  }
  return (
    <div className="stack-vertical">
      <p>
        <StatusBadge status="ok" label="Connected" />
      </p>
      <KeyValueList
        items={[
          ["Topology", result.topology ?? "unknown"],
          ["Server version", result.serverVersion ?? "unknown"],
          [
            "Backup privileges",
            <PrivilegeList key="backup" missing={result.missingBackupPrivileges} />,
          ],
          [
            "Restore privileges",
            <PrivilegeList key="restore" missing={result.missingRestorePrivileges} />,
          ],
        ]}
      />
    </div>
  );
}

function PrivilegeList(props: { missing: readonly string[] }) {
  if (props.missing.length === 0) return <StatusBadge status="ok" label="All present" />;
  return (
    <div>
      <StatusBadge status="incomplete" label={`${props.missing.length} missing`} />
      <ul className="compact-list">
        {props.missing.map((privilege) => (
          <li key={privilege}>
            <code>{privilege}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Add/edit form. The URI field is write-only: it is never filled from the server. */
export function ConnectionDialog(props: {
  connection: ConnectionView | undefined;
  onClose: () => void;
  onSaved: (connection: ConnectionView) => void;
}) {
  const client = useApi();
  const existing = props.connection;
  const [name, setName] = useState(existing?.name ?? "");
  const [uri, setUri] = useState("");
  const [production, setProduction] = useState(existing?.production ?? false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const errors = {
    name: name.trim() === "" ? "Give the connection a name, e.g. “Production cluster”." : undefined,
    uri:
      existing === undefined && uri.trim() === ""
        ? "Paste the connection string."
        : uri.trim() !== "" && !/^mongodb(\+srv)?:\/\//.test(uri.trim())
          ? "A connection string starts with mongodb:// or mongodb+srv://."
          : undefined,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (errors.name !== undefined || errors.uri !== undefined) return;
    setBusy(true);
    setError(undefined);
    // Only send the URI when the user typed a new one; omitting it keeps the stored secret.
    const input: ConnectionInput = {
      name: name.trim(),
      production,
      ...(uri.trim() === "" ? {} : { uri: uri.trim() }),
    };
    try {
      const saved =
        existing === undefined
          ? await client.call("POST /api/connections", input)
          : await client.call("PUT /api/connections/:id", input, { params: { id: existing.id } });
      // Clear the secret from memory as soon as it has been sent.
      setUri("");
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
      title={existing === undefined ? "Add connection" : `Edit "${existing.name}"`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" busy={busy}>
            {existing === undefined ? "Add and test" : "Save and test"}
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={submit} noValidate className="form">
        <TextField
          label="Name"
          value={name}
          onValue={setName}
          data-autofocus
          error={submitted ? errors.name : undefined}
        />
        <TextField
          label="Connection string"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={uri}
          onValue={setUri}
          placeholder={
            existing === undefined
              ? "mongodb+srv://user:password@cluster.example.net"
              : "Leave empty to keep the stored connection string"
          }
          hint={
            existing?.uri.preview === undefined ? (
              "Stored encrypted. It is never shown again after saving."
            ) : (
              <>
                Stored: <code>{existing.uri.preview}</code>. Type a new one only to replace it.
              </>
            )
          }
          error={submitted ? errors.uri : undefined}
        />
        <CheckboxField
          label="This is a production deployment"
          checked={production}
          onChecked={setProduction}
          hint="Restores into production need the admin role and typing the connection name to confirm. Drills never target production."
        />
        {error === undefined ? null : <ErrorNotice error={error} title="Could not save" />}
      </form>
    </Dialog>
  );
}
