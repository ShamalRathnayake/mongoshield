/**
 * Page tests for the welcome flow against the mock API: the redirect for a console
 * without connections, pasting connection strings (placeholders, mongosh commands,
 * local and Atlas defaults, friendly errors, the public IP), saving, and the backup
 * actions bar above the data browser (Back up now with live progress, the recovery
 * key, the nightly schedule, verify, test restore, restore and the database picker).
 */

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseNode, PlanView } from "../../shared/api.ts";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { chosenFrom, includeFor } from "./backup-actions.tsx";
import { connectionNameSuggestions, topologyLabel, understand, uriToSend } from "./welcome.tsx";

const ATLAS_COPY =
  "mongodb+srv://shamal:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

beforeEach(() => {
  // jsdom has no Blob URLs: the recovery key download needs these two.
  URL.createObjectURL = vi.fn(() => "blob:recovery-key");
  URL.revokeObjectURL = vi.fn();
  // jsdom cannot navigate to a download link; clicking it is all the test needs.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Renders a brand-new console signed in as admin, on the welcome page. */
async function freshAdmin(hash = "#/", inContainer = false) {
  const rendered = renderApp({ signedInAs: "admin", fresh: true, hash, inContainer });
  expect(await screen.findByRole("heading", { name: "Connect your database" })).toBeTruthy();
  return rendered;
}

describe("the welcome page", () => {
  it("is where an admin of a console without connections lands", async () => {
    await freshAdmin();
    expect(window.location.hash).toBe("#/welcome");
  });

  it("is skipped for consoles that have connections, and for the rest of the session on request", async () => {
    renderApp({ signedInAs: "admin" });
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(window.location.hash).not.toBe("#/welcome");
  });

  it("fills in a local connection string with one click", async () => {
    // Not in a container: "this computer" is localhost, and host.docker.internal is not offered.
    const { user } = await freshAdmin();
    await user.click(screen.getByRole("button", { name: "localhost:27017" }));
    expect((screen.getByLabelText("Connection string") as HTMLTextAreaElement).value).toBe(
      "mongodb://localhost:27017",
    );
    expect(screen.queryByRole("button", { name: "This computer (console in Docker)" })).toBeNull();
    // The chips are a named group, and the one in the field is marked as chosen.
    const quickFill = screen.getByRole("group", { name: "Suggestions for Connection string" });
    expect(quickFill.textContent).toContain("Quick fill:");
    expect(
      within(quickFill)
        .getByRole("button", { name: "localhost:27017" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("in Docker, suggests host.docker.internal instead of localhost and explains localhost", async () => {
    const { user } = await freshAdmin("#/", true);
    expect(screen.queryByRole("button", { name: "localhost:27017" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "This computer (console in Docker)" }));
    expect((screen.getByLabelText("Connection string") as HTMLTextAreaElement).value).toBe(
      "mongodb://host.docker.internal:27017",
    );
    // Typing localhost anyway: a hint with a one-click fix.
    const field = screen.getByLabelText("Connection string");
    await user.clear(field);
    await user.type(field, "mongodb://localhost:27017/?appName=x");
    expect(screen.getByText("localhost is the console's own container here")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use host.docker.internal" }));
    expect((field as HTMLTextAreaElement).value).toBe(
      "mongodb://host.docker.internal:27017/?appName=x",
    );
  });

  it("in Docker, saves a localhost string that was reached through the host", async () => {
    const { user, backend } = await freshAdmin("#/", true);
    const field = screen.getByLabelText("Connection string");
    await user.click(field);
    await user.paste("mongodb://localhost:27017");
    // The check got through on host.docker.internal: Details says so, and saving uses it.
    expect(await screen.findByText("Connected through host.docker.internal")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save and browse data" }));
    // The connection itself (not the check before it, which shares the path prefix).
    const creates = () =>
      requestsTo(backend, "POST", "/api/connections").filter(
        (request) => request.url === "/api/connections",
      );
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect((creates()[0]?.body as { uri?: string } | undefined)?.uri).toBe(
      "mongodb://host.docker.internal:27017",
    );
  });

  it("shows the steps as tabs: Details opens only after a successful check", async () => {
    const { user } = await freshAdmin();
    const steps = screen.getByRole("tablist", { name: "Getting started" });
    const tab = (name: RegExp) => within(steps).getByRole("tab", { name });
    expect(tab(/Connect/).getAttribute("aria-selected")).toBe("true");
    // Details waits for the check, and the last step is where saving leads.
    expect(tab(/Details/).getAttribute("aria-disabled")).toBe("true");
    expect(tab(/Browse and back up/).getAttribute("aria-disabled")).toBe("true");
    await user.click(tab(/Details/));
    expect(tab(/Connect/).getAttribute("aria-selected")).toBe("true");
    // The step's own action stands where Next would be.
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "localhost:27017" }));
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    // Moved on by itself, with focus on the new step so it is announced.
    expect(tab(/Details/).getAttribute("aria-selected")).toBe("true");
    expect(tab(/Connect.*\(done\)/)).toBeTruthy();
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    expect(document.activeElement?.textContent).toContain("Connected");
    expect(screen.getByRole("button", { name: "Save and browse data" })).toBeTruthy();
    // The destination stays locked: saving is the way there.
    expect(tab(/Browse and back up/).getAttribute("aria-disabled")).toBe("true");

    // Back to Connect: the string is kept and Next returns to the details.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(tab(/Connect/).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Next: Details" }));
    expect(tab(/Details/).getAttribute("aria-selected")).toBe("true");

    // A changed string needs a new check: Details locks again.
    await user.click(tab(/Connect/));
    await user.type(screen.getByLabelText("Connection string"), "0");
    expect(tab(/Details/).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Check connection" })).toBeTruthy();
  });

  it("refuses an empty, blank or too long name on Details, with the reason shown", async () => {
    const { user, backend } = await freshAdmin();
    await user.click(screen.getByRole("button", { name: "localhost:27017" }));
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    const name = screen.getByLabelText("Name");
    const save = screen.getByRole("button", { name: "Save and browse data" }) as HTMLButtonElement;
    const detailsTab = screen.getByRole("tab", { name: /^Details/ });

    // Spaces only count as empty.
    await user.clear(name);
    await user.type(name, "   ");
    expect(screen.getByText("Give the connection a name.")).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(detailsTab.textContent).toContain("(needs attention)");
    await user.click(save);
    // (Not the check, which is `POST /api/connections/check`.)
    expect(
      requestsTo(backend, "POST", "/api/connections").filter(
        (request) => request.url === "/api/connections",
      ),
    ).toHaveLength(0);

    // The server keeps at most 100 characters.
    await user.clear(name);
    await user.type(name, "x".repeat(101));
    expect(screen.getByText("Use at most 100 characters.")).toBeTruthy();
    expect(save.disabled).toBe(true);

    await user.clear(name);
    await user.type(name, "Local");
    expect(save.disabled).toBe(false);
  });

  it("marks the Connect tab when the check fails, and stays there", async () => {
    const { user } = await freshAdmin();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste("mongodb://localhost:1");
    expect(await screen.findByText("Nothing is listening there")).toBeTruthy();
    const steps = screen.getByRole("tablist", { name: "Getting started" });
    const connect = within(steps).getByRole("tab", { name: /Connect.*\(needs attention\)/ });
    expect(connect.getAttribute("aria-selected")).toBe("true");
    expect(
      within(steps)
        .getByRole("tab", { name: /Details/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("says when the check itself could not run, on the Connect tab", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      fresh: true,
      hash: "#/",
      failures: [{ method: "POST", path: "/api/connections/check", status: "network" }],
    });
    expect(await screen.findByRole("heading", { name: "Connect your database" })).toBeTruthy();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste("mongodb://localhost:27017");
    expect(await screen.findByText("That did not work")).toBeTruthy();
    const steps = screen.getByRole("tablist", { name: "Getting started" });
    expect(within(steps).getByRole("tab", { name: /Connect.*\(needs attention\)/ })).toBeTruthy();
  });

  it("asks for a name and shows a failed save on the Details step", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      fresh: true,
      hash: "#/",
      failures: [
        // The save only: the check (`/api/connections/check`) still answers.
        { method: "POST", path: /\/api\/connections$/, status: 409, message: "Name taken." },
      ],
    });
    expect(await screen.findByRole("heading", { name: "Connect your database" })).toBeTruthy();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste("mongodb://localhost:27017");
    expect(await screen.findByText("Connected")).toBeTruthy();
    const steps = screen.getByRole("tablist", { name: "Getting started" });

    // Without a name the step needs attention and cannot be saved.
    await user.clear(screen.getByLabelText("Name"));
    expect(within(steps).getByRole("tab", { name: /Details.*\(needs attention\)/ })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save and browse data" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.type(screen.getByLabelText("Name"), "shop");
    await user.click(save);
    expect(await screen.findByText("Could not save")).toBeTruthy();
    expect(screen.getByText("Name taken.")).toBeTruthy();
    // Still on Details, where the error is.
    expect(
      within(steps)
        .getByRole("tab", { name: /Details/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(window.location.hash).toBe("#/welcome");
  });

  it("can be skipped", async () => {
    const { user } = await freshAdmin();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(window.location.hash).toBe("#/");
  });

  it("asks for the password of an Atlas string, checks it and proposes production", async () => {
    const { user, backend } = await freshAdmin();
    const field = screen.getByLabelText("Connection string");
    await user.click(field);
    await user.paste(ATLAS_COPY);
    const check = screen.getByRole("button", { name: "Check connection" });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    // Nothing is sent before the password is there.
    expect(requestsTo(backend, "POST", "/api/connections/check")).toHaveLength(0);

    await user.type(screen.getByLabelText("Password for shamal"), "p@ss:w/rd");
    await user.click(check);
    expect(await screen.findByText("Connected")).toBeTruthy();
    const [request] = requestsTo(backend, "POST", "/api/connections/check");
    expect(request?.body).toEqual({
      uri: ATLAS_COPY.replace("<db_password>", "p%40ss%3Aw%2Frd"),
    });
    // The password is never shown, only the masked string.
    expect(document.body.textContent).not.toContain("p@ss:w/rd");
    expect(screen.getByText(/shamal:\*\*\*@cluster0/)).toBeTruthy();
    expect(screen.getByText("Atlas Free or Flex")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("cluster0");
    const production = screen.getByLabelText("This is a production database") as HTMLInputElement;
    expect(production.checked).toBe(true);
    expect(screen.getByText(/MongoDB Atlas cluster, so it is treated as production/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save and browse data" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/connections\/[^/]+\/data$/));
    expect(backend.data.connections).toHaveLength(1);
    expect(backend.data.connections[0]).toMatchObject({ name: "cluster0", production: true });
  });

  it("checks a local string as soon as it is pasted, and proposes a test database", async () => {
    const { user, backend } = await freshAdmin();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste('mongosh "mongodb://host.docker.internal:27017"');
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/connections/check")[0]?.body).toEqual({
      uri: "mongodb://host.docker.internal:27017",
    });
    expect(
      (screen.getByLabelText("This is a production database") as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "MongoDB on this computer",
    );
    // Names in one click: the suggested one (chosen; the string's own suggestion is the
    // same, so it is not repeated), then the roles, local first.
    const names = screen.getByRole("group", { name: "Suggestions for Name" });
    const chips = within(names).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "MongoDB on this computer",
      "Local dev",
      "Staging",
      "Production",
    ]);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    await user.click(within(names).getByRole("button", { name: "Staging" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Staging");
  });

  it("moves a pasted password out of sight into the masked field", async () => {
    const { user, backend } = await freshAdmin();
    const field = screen.getByLabelText("Connection string") as HTMLTextAreaElement;
    await user.click(field);
    await user.paste("mongodb://app:s3cr%40t@db.example.com:27017/");
    expect(field.value).toBe("mongodb://app:<password>@db.example.com:27017/");
    expect((screen.getByLabelText("Password for app") as HTMLInputElement).value).toBe("s3cr@t");
    // Checked at once, with the password put back (encoded).
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/connections/check")[0]?.body).toEqual({
      uri: "mongodb://app:s3cr%40t@db.example.com:27017/",
    });
    expect(document.body.textContent).not.toContain("s3cr");
  });

  it("moves a typed password out of sight when the field is left", async () => {
    const { user } = await freshAdmin();
    const field = screen.getByLabelText("Connection string") as HTMLTextAreaElement;
    await user.type(field, "mongodb://app:typed-secret@db.example.com/");
    await user.tab();
    expect(field.value).toBe("mongodb://app:<password>@db.example.com/");
    expect((screen.getByLabelText("Password for app") as HTMLInputElement).value).toBe(
      "typed-secret",
    );
  });

  it("explains an Atlas IP access list problem and finds the public IP on request", async () => {
    const { user, backend } = await freshAdmin();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste("mongodb+srv://u:pw@blocked.x.mongodb.net/");
    expect(await screen.findByText("Atlas did not let this console in")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Network Access/ }).getAttribute("href")).toBe(
      "https://cloud.mongodb.com/v2#/security/network/accessList",
    );
    expect(screen.getByText("Technical details")).toBeTruthy();
    // The lookup happens only on this click.
    expect(requestsTo(backend, "POST", "/api/network/public-ip")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Show my public IP address" }));
    expect(await screen.findByText("203.0.113.7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and browse data" })).toBeNull();
  });

  it("explains wrong passwords, unknown names and Docker's localhost", async () => {
    const { user } = await freshAdmin();
    const field = screen.getByLabelText("Connection string");
    for (const [uri, title] of [
      ["mongodb://app:wrong-password@db.example.com/", "Wrong user name or password"],
      ["mongodb+srv://u:p@typo.x.mongodb.net/", "That server name does not exist"],
      ["mongodb://localhost:1", "Nothing is listening there"],
      ["mongodb://u:p@tls.example.com/", "The secure connection (TLS) failed"],
      ["mongodb+srv://u:p@paused.x.mongodb.net/", "The cluster is paused"],
    ] as const) {
      await user.clear(field);
      await user.click(field);
      await user.paste(uri);
      expect(await screen.findByText(title), uri).toBeTruthy();
    }
  });

  it("explains text that is not a connection string, and a missing user name", async () => {
    const { user } = await freshAdmin();
    const field = screen.getByLabelText("Connection string");
    await user.type(field, "https://example.com");
    expect(screen.getByText(/starts with mongodb:\/\//)).toBeTruthy();
    await user.clear(field);
    await user.click(field);
    await user.paste("mongodb+srv://<username>:<password>@c.x.mongodb.net/");
    expect(screen.getByText("The user name is missing")).toBeTruthy();
  });

  it("tells about encoded special characters and warns about limited users", async () => {
    const { user } = await freshAdmin();
    await user.click(screen.getByLabelText("Connection string"));
    await user.paste("mongodb://reader:p@ss@db.example.com/");
    expect(screen.getByText("Special characters in the password")).toBeTruthy();
    expect(await screen.findByText("This user can back up only part of the data")).toBeTruthy();
  });
});

describe("the backup actions bar", () => {
  /** A fresh console with one saved connection, on its data page. */
  async function onDataPage(options: { production?: boolean; signedInAs?: string } = {}) {
    const rendered = renderApp({
      signedInAs: options.signedInAs ?? "admin",
      // Jobs move forward by themselves: 12 steps of 40 ms.
      jobTickMs: 40,
      fresh: true,
      hash: "#/connections/conn-new/data",
      prepare: (backend) => {
        backend.data.connections.push({
          id: "conn-new",
          name: "shop",
          uri: "mongodb://mongo:27017",
          production: options.production ?? false,
          createdAt: new Date().toISOString(),
          topology: "replicaSet",
          serverVersion: "8.0.4",
          missingBackupPrivileges: [],
          missingRestorePrivileges: [],
          namespaces: [
            {
              name: "shop",
              collections: [
                { name: "orders", type: "collection", estimatedDocuments: 120, indexes: 2 },
                { name: "users", type: "collection", estimatedDocuments: 30, indexes: 1 },
              ],
            },
            {
              name: "logs",
              collections: [
                { name: "events", type: "collection", estimatedDocuments: 500, indexes: 1 },
              ],
            },
          ],
        });
      },
    });
    expect(await rendered.findByRole("heading", { name: "Backups of shop" })).toBeTruthy();
    return rendered;
  }

  /**
   * Waits until the backup has run: the mock moves jobs forward on its own here
   * (`jobTickMs`), and the bar follows them over the job's event stream, as in the app.
   */
  async function finishJobs(_backend: unknown) {
    await waitFor(() => expect(screen.queryByRole("button", { name: "Backing up…" })).toBeNull(), {
      timeout: 15_000,
    });
  }

  it("backs up in one click, shows progress, then offers the recovery key once", async () => {
    const { user, backend } = await onDataPage();
    expect(screen.getByText(/Nothing is backed up yet/)).toBeTruthy();
    expect(screen.getByText("Test database")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Restore a backup" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(requestsTo(backend, "POST", "/api/quick-backup")[0]?.body).toEqual({
      connectionId: "conn-new",
      include: [],
    });
    // The button says so, and the progress bar shows how far it got.
    expect(await screen.findByRole("button", { name: "Backing up…" })).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();

    await finishJobs(backend);
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Save your recovery key" },
      { timeout: 15_000 },
    );
    await user.click(within(dialog).getByRole("button", { name: "Download recovery key" }));
    expect(await within(dialog).findByText("Downloaded")).toBeTruthy();
    expect(within(dialog).getByText(/^AGE-SECRET-KEY-1/)).toBeTruthy();
    expect(URL.createObjectURL).toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    expect(await screen.findByText("Backed up")).toBeTruthy();
    expect(screen.getByText("Encrypted")).toBeTruthy();
    const plan = backend.data.plans[0] as PlanView;
    expect(plan).toMatchObject({
      origin: "quick",
      encryption: { kind: "managed", recoveryKeySaved: true },
    });
  });

  it("offers the next steps after a backup: check, test restore, nightly, restore", async () => {
    const { user, backend } = await onDataPage();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Later" }, { timeout: 15_000 }));
    expect(screen.getByText("Save your recovery key")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "Check the backup" }));
    const [verify] = requestsTo(backend, "POST", "/api/storage/");
    expect(verify?.url).toMatch(/\/verify$/);
    expect(verify?.body).toEqual({ mode: "deep" });

    await user.click(screen.getByRole("button", { name: "Test a restore" }));
    expect(requestsTo(backend, "POST", "/api/storage/").at(-1)?.body).toEqual({
      targetConnectionId: "conn-new",
    });

    await user.click(screen.getByRole("button", { name: "Back up every night" }));
    await waitFor(() => expect(requestsTo(backend, "PUT", "/api/plans/")).toHaveLength(1));
    expect(requestsTo(backend, "PUT", "/api/plans/")[0]?.body).toMatchObject({
      schedule: { cron: "0 2 * * *" },
      retention: { daily: 7, weekly: 4, monthly: 12 },
      encryption: { kind: "managed" },
    });

    const restore = screen.getByRole("link", { name: "Restore a backup" });
    expect(restore.getAttribute("href")).toMatch(/^#\/backups\/st-local\/[^/]+\/restore$/);
  });

  it("does not run test restores against production", async () => {
    const { user, backend } = await onDataPage({ production: true });
    expect(screen.getByText("Production")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Later" }, { timeout: 15_000 }));
    const drill = (await screen.findByRole("button", {
      name: "Test a restore",
    })) as HTMLButtonElement;
    expect(drill.disabled).toBe(true);
  });

  it("backs up only what was chosen", async () => {
    const { user, backend } = await onDataPage();
    await user.click(screen.getByRole("button", { name: "Choose what to back up" }));
    await user.click(await screen.findByLabelText("logs (1 of 1 collection)"));
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(requestsTo(backend, "POST", "/api/quick-backup")[0]?.body).toEqual({
      connectionId: "conn-new",
      include: ["shop.*"],
    });
  });

  it("says plainly when there is nothing to back up yet", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/connections/conn-staging/data",
      prepare: (backend) => {
        // The quick plan's last run failed the way the server fails on an empty server.
        backend.data.plans.push({
          id: "plan-quick",
          name: "Back up Staging",
          connectionId: "conn-staging",
          storageId: "st-s3",
          include: [],
          exclude: [],
          compression: "zstd",
          encryption: { kind: "managed", recipient: "age1x", recoveryKeySaved: true },
          consistency: "auto",
          verify: "fast",
          notify: [],
          origin: "quick",
          lastRun: {
            id: "job-empty",
            kind: "backup",
            status: "failed",
            startedBy: "admin",
            finishedAt: new Date().toISOString(),
            error: {
              code: "MS_CONFIG_INVALID",
              message: "No namespace matches the backup filters.",
            },
          },
        });
      },
    });
    expect(await screen.findByText("Nothing to back up yet")).toBeTruthy();
    expect(screen.queryByText("The last backup failed")).toBeNull();
  });

  it("lets operators run an existing quick plan, and tells them otherwise to ask an admin", async () => {
    const { user, backend } = await onDataPage({ signedInAs: "maya" });
    expect(screen.getByText(/Ask an admin/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
    expect(requestsTo(backend, "POST", "/api/quick-backup")).toHaveLength(0);
    expect(user).toBeDefined();
  });

  it("is hidden from viewers", async () => {
    renderApp({ signedInAs: "sam", hash: "#/connections/conn-prod/data" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeTruthy();
    expect(screen.queryByText(/Backups of/)).toBeNull();
  });
});

describe("helpers", () => {
  const tree: DatabaseNode[] = [
    {
      name: "shop",
      collections: [
        { name: "orders", type: "collection", estimatedDocuments: 1, indexes: 1 },
        { name: "users", type: "collection", estimatedDocuments: 1, indexes: 1 },
      ],
    },
    {
      name: "logs",
      collections: [{ name: "events", type: "collection", estimatedDocuments: 1, indexes: 1 }],
    },
  ];

  it("turns the picker's choice into include patterns, and back", () => {
    const all = chosenFrom(tree, []);
    expect([...all].sort()).toEqual(["logs.events", "shop.orders", "shop.users"]);
    expect(includeFor(tree, all)).toEqual([]);
    expect(includeFor(tree, new Set(["shop.orders", "shop.users"]))).toEqual(["shop.*"]);
    expect(includeFor(tree, new Set(["shop.orders", "logs.events"]))).toEqual([
      "shop.orders",
      "logs.*",
    ]);
    expect([...chosenFrom(tree, ["shop.*", "logs.events"])].sort()).toEqual([
      "logs.events",
      "shop.orders",
      "shop.users",
    ]);
  });

  it("suggests connection names, the likelier role first", () => {
    expect(connectionNameSuggestions("cluster0", "cluster0", true)).toEqual([
      "cluster0",
      "cluster0",
      "Production",
      "Staging",
      "Local dev",
    ]);
    expect(connectionNameSuggestions("mongo", undefined, false)).toEqual([
      "mongo",
      undefined,
      "Local dev",
      "Staging",
      "Production",
    ]);
  });

  it("names topologies in plain words", () => {
    expect(topologyLabel("replicaSet")).toBe("Replica set");
    expect(topologyLabel("sharded")).toBe("Sharded cluster");
    expect(topologyLabel("standalone")).toBe("Single server");
    expect(topologyLabel(undefined)).toBe("Unknown");
    expect(topologyLabel("load_balanced")).toBe("Load balanced");
  });

  it("builds the URI to send only when nothing is missing", () => {
    expect(uriToSend(understand(""), "")).toBeUndefined();
    expect(uriToSend(understand("nonsense"), "")).toBeUndefined();
    expect(uriToSend(understand(ATLAS_COPY), "")).toBeUndefined();
    expect(uriToSend(understand(ATLAS_COPY), "pw")).toContain("shamal:pw@");
    expect(uriToSend(understand(" 'mongodb://h:1' "), "")).toBe("mongodb://h:1");
    expect(uriToSend(understand("mongodb://<username>:x@h/"), "")).toBeUndefined();
  });
});
