/**
 * Users (admins only): who can sign in and with which role.
 *
 * Roles build on each other: viewer (read everything except secrets) → operator (run
 * backups, verifies and drills, restore into non-production) → admin (everything).
 * Passwords are write-only; leaving the field empty when editing keeps the current one.
 *
 * With single sign-on enabled (OIDC or the trusted proxy), a new user may be created
 * without a password: such an account can only sign in through SSO. That is how admins
 * let people in when OIDC auto-provisioning is turned off.
 *
 * Permissions are granted on top of the role: "Can edit live data" (`data:write`) lets
 * an operator or admin change documents in the live data browser, on connections where
 * live edits are allowed. Being an admin does not include it; viewers cannot hold it.
 */

import { type FormEvent, useState } from "react";
import { ROLES, type Role, type UserInput, type UserView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import { CheckboxField, SelectField, TextField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { MIN_PASSWORD_LENGTH } from "./setup.tsx";

/** What each role may do, shown next to the role picker. */
const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  viewer: "Viewer — sees everything except secrets",
  operator: "Operator — runs backups, verifies and drills; restores into non-production",
  admin: "Admin — everything, including users and restores into production",
};

/** The users page. */
export function UsersPage() {
  const client = useApi();
  const toast = useToast();
  const { user: me } = useSession();
  const users = useLoad("users", (signal) => client.call("GET /api/users", undefined, { signal }));
  const [editing, setEditing] = useState<UserView | "new" | undefined>(undefined);
  const [deleting, setDeleting] = useState<UserView | undefined>(undefined);

  const remove = async (user: UserView) => {
    try {
      await client.call("DELETE /api/users/:id", undefined, { params: { id: user.id } });
      toast.show("success", `Deleted ${user.username}.`);
      users.reload();
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setDeleting(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can sign in, and what they may do."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            Add user
          </Button>
        }
      />
      {users.error !== undefined ? (
        <ErrorNotice error={users.error} onRetry={users.reload} />
      ) : null}
      {users.data === undefined ? (
        users.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Users"
          rows={users.data}
          rowKey={(user) => user.id}
          empty={<EmptyState title="No users" />}
          columns={[
            {
              key: "name",
              header: "Username",
              sortValue: (user) => user.username,
              render: (user) =>
                user.id === me?.id ? (
                  <>
                    {user.username} <span className="muted">(you)</span>
                  </>
                ) : (
                  user.username
                ),
            },
            {
              key: "role",
              header: "Role",
              sortValue: (user) => ROLES.indexOf(user.role),
              render: (user) => user.role,
            },
            {
              key: "permissions",
              header: "Permissions",
              hideOnNarrow: true,
              render: (user) =>
                user.permissions.includes("data:write") ? (
                  "Edits live data"
                ) : (
                  <span className="muted">None</span>
                ),
            },
            {
              key: "signIn",
              header: "Signs in with",
              hideOnNarrow: true,
              render: (user) => (user.signIn === "sso" ? "Single sign-on" : "Password"),
            },
            {
              key: "last",
              header: "Last sign-in",
              render: (user) =>
                user.lastLoginAt === undefined ? (
                  <span className="muted">Never</span>
                ) : (
                  <Time value={user.lastLoginAt} relativeOnly />
                ),
            },
            {
              key: "created",
              header: "Added",
              hideOnNarrow: true,
              render: (user) => <Time value={user.createdAt} relativeOnly />,
            },
            {
              key: "actions",
              header: <span className="visually-hidden">Actions</span>,
              align: "end",
              render: (user) => (
                <span className="row-actions">
                  <Button
                    size="small"
                    onClick={() => setEditing(user)}
                    aria-label={`Edit ${user.username}`}
                  >
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={user.id === me?.id}
                    onClick={() => setDeleting(user)}
                    aria-label={`Delete ${user.username}`}
                  >
                    Delete
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
      {editing === undefined ? null : (
        <UserDialog
          user={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            users.reload();
            toast.show("success", `Saved ${saved.username}.`);
          }}
        />
      )}
      <Dialog
        open={deleting !== undefined}
        title={`Delete ${deleting?.username ?? ""}?`}
        description="They are signed out immediately. Their audit log entries are kept."
        onClose={() => setDeleting(undefined)}
        footer={
          <>
            <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete user
            </Button>
          </>
        }
      >
        <p>This cannot be undone.</p>
      </Dialog>
    </>
  );
}

function UserDialog(props: {
  user: UserView | undefined;
  onClose: () => void;
  onSaved: (user: UserView) => void;
}) {
  const client = useApi();
  const { session } = useSession();
  // SSO-only accounts make sense only when some single sign-on method is enabled.
  const ssoEnabled = session.authMethods.includes("oidc") || session.authMethods.includes("proxy");
  const existing = props.user;
  const [username, setUsername] = useState(existing?.username ?? "");
  const [role, setRole] = useState<Role>(existing?.role ?? "viewer");
  const [password, setPassword] = useState("");
  const [dataWrite, setDataWrite] = useState(existing?.permissions.includes("data:write") ?? false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const errors = {
    username: username.trim() === "" ? "Enter a username." : undefined,
    password:
      existing === undefined && password === "" && !ssoEnabled
        ? "Set an initial password."
        : password !== "" && password.length < MIN_PASSWORD_LENGTH
          ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
          : undefined,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (errors.username !== undefined || errors.password !== undefined) return;
    setBusy(true);
    const input: UserInput = {
      username: username.trim(),
      role,
      ...(password === "" ? {} : { password }),
      // Viewers cannot hold permissions; the server refuses them.
      permissions: dataWrite && role !== "viewer" ? ["data:write"] : [],
    };
    try {
      const saved =
        existing === undefined
          ? await client.call("POST /api/users", input)
          : await client.call("PUT /api/users/:id", input, { params: { id: existing.id } });
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
      title={existing === undefined ? "Add user" : `Edit ${existing.username}`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate className="form">
        <TextField
          label="Username"
          value={username}
          onValue={setUsername}
          autoComplete="off"
          data-autofocus
          error={submitted ? errors.username : undefined}
        />
        <SelectField
          label="Role"
          value={role}
          options={ROLES.map((value) => ({ value, label: ROLE_DESCRIPTIONS[value] }))}
          onValue={setRole}
        />
        <CheckboxField
          label="Can edit live data (data:write)"
          checked={dataWrite && role !== "viewer"}
          disabled={role === "viewer"}
          onChecked={setDataWrite}
          hint={
            role === "viewer"
              ? "Viewers cannot edit live data. Choose the operator or admin role first."
              : "Insert, edit and delete documents in the live data browser, on connections where an admin allowed live edits. Every change is journaled and can be undone."
          }
        />
        <TextField
          label={existing === undefined ? "Initial password" : "New password"}
          type="password"
          autoComplete="new-password"
          value={password}
          onValue={setPassword}
          hint={
            existing !== undefined
              ? "Leave empty to keep the current password."
              : ssoEnabled
                ? `At least ${MIN_PASSWORD_LENGTH} characters, or leave empty for an account that signs in only with single sign-on.`
                : `At least ${MIN_PASSWORD_LENGTH} characters. Share it securely.`
          }
          error={submitted ? errors.password : undefined}
        />
        {error === undefined ? null : <ErrorNotice error={error} title="Could not save" />}
      </form>
    </Dialog>
  );
}
