/**
 * Storage dialog tests, per type: the "Type" select and its fields, the URL they build
 * (shown read-only), provider presets and the AWS region select, parsing an existing
 * location back into fields, the "Edit as URL" mode and its fallback, and the named
 * credential fields with what they send (including file upload and keeping or clearing
 * stored credentials), and the two steps of the dialog (Location, Sign in): moving
 * between them, the locked sign-in step of a local folder, and saves that jump to the
 * step with a problem; and the one-click suggestions under the free-text fields.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type RenderAppOptions, renderApp, requestsTo } from "../testing.tsx";
import {
  advancedUrlProblem,
  folderNameOf,
  localFolderSuggestions,
  prefixSuggestions,
  storageNameProblem,
  storageNameSuggestions,
} from "./storage-form.tsx";

/** A valid SSH host key fingerprint. */
const FINGERPRINT = "SHA256:k3S1xS1v8bM0gYp4m7bJ1rQ6yQ0b0v8vXr5Y2rVwA6c";

/** Opens the "Add storage" dialog as an admin and names the location. */
async function openAddDialog() {
  const rendered = renderApp({ signedInAs: "admin", hash: "#/storage" });
  await rendered.user.click(await screen.findByRole("button", { name: "Add storage" }));
  const dialog = screen.getByRole("dialog", { name: "Add storage" });
  await rendered.user.type(within(dialog).getByLabelText("Name"), "New place");
  return { ...rendered, dialog };
}

/** Opens the edit dialog of a fixture (or prepared) location. */
async function openEditDialog(name: string, prepare?: RenderAppOptions["prepare"]) {
  const rendered = renderApp({
    signedInAs: "admin",
    hash: "#/storage",
    ...(prepare === undefined ? {} : { prepare }),
  });
  await rendered.user.click(await screen.findByRole("button", { name: `Edit ${name}` }));
  const dialog = screen.getByRole("dialog", { name: `Edit "${name}"` });
  return { ...rendered, dialog };
}

/** The dialog's user-event instance (as returned by `renderApp`). */
type User = ReturnType<typeof renderApp>["user"];

/** Opens a step of the dialog by clicking its tab ("Location" or "Sign in"). */
async function openStep(user: User, dialog: HTMLElement, title: "Location" | "Sign in") {
  await user.click(within(dialog).getByRole("tab", { name: new RegExp(`^${title}`) }));
}

/** The tab of a step, to check whether it is selected, locked or needs attention. */
function stepTab(dialog: HTMLElement, title: "Location" | "Sign in"): HTMLElement {
  return within(dialog).getByRole("tab", { name: new RegExp(`^${title}`) });
}

/** The read-only URL the fields build. */
function resultingUrl(dialog: HTMLElement): string | null {
  return within(dialog).getByLabelText("Resulting URL").textContent;
}

/** The body of the last create request. */
function lastCreate(backend: ReturnType<typeof renderApp>["backend"]): unknown {
  // Not the automatic test that follows (`POST /api/storage/:id/test`).
  return requestsTo(backend, "POST", "/api/storage")
    .filter((request) => request.url === "/api/storage")
    .at(-1)?.body;
}

describe("storage dialog: location fields", () => {
  it("offers every supported type in the Type select", async () => {
    const { dialog } = await openAddDialog();
    const options = within(within(dialog).getByLabelText("Type"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Amazon S3",
      "S3-compatible (Cloudflare R2, MinIO, Backblaze B2, Wasabi…)",
      "Google Cloud Storage",
      "Azure Blob Storage",
      "SFTP server",
      "Local folder (in the console's data volume)",
    ]);
  });

  it("shows a hint instead of a half-built URL until the bucket is filled in", async () => {
    const { user, dialog } = await openAddDialog();
    expect(resultingUrl(dialog)).toBe("Fill in the fields above");
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    expect(resultingUrl(dialog)).toBe("s3://acme/");
  });

  it("picks an AWS region from the list or types another", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Bucket"), "acme-eu");
    const region = within(dialog).getByLabelText("Region");
    await user.selectOptions(region, "eu-west-1");
    expect(resultingUrl(dialog)).toBe("s3://acme-eu/?region=eu-west-1");

    await user.selectOptions(region, "Other region…");
    const code = within(dialog).getByLabelText("Region code");
    await user.type(code, "EU 9");
    // Next stays on Location while a field there is wrong, and focuses it.
    await user.click(within(dialog).getByRole("button", { name: /Next: Sign in/ }));
    expect(within(dialog).getByText("Regions look like eu-west-1.")).toBeTruthy();
    expect(stepTab(dialog, "Location").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(code);

    await user.clear(code);
    await user.type(code, "ap-southeast-3");
    await openStep(user, dialog, "Sign in");
    await user.click(within(dialog).getByRole("radio", { name: /The console's environment/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    // The console's environment stores nothing.
    expect(lastCreate(backend)).toEqual({
      name: "New place",
      url: "s3://acme-eu/?region=ap-southeast-3",
      credentials: {},
    });
  });

  it("builds S3-compatible endpoints from the provider presets", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "s3-compatible");
    // Cloudflare R2 is the first provider: it needs the account ID.
    await user.type(within(dialog).getByLabelText("Bucket"), "offsite");
    // "Sign in" is closed until the account ID is there; clicking it says so.
    expect(stepTab(dialog, "Sign in").getAttribute("aria-disabled")).toBe("true");
    await openStep(user, dialog, "Sign in");
    expect(within(dialog).getByText("Enter the Cloudflare account ID.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Cloudflare account ID"));
    await user.type(within(dialog).getByLabelText("Cloudflare account ID"), "abc123");
    expect(resultingUrl(dialog)).toBe(
      "s3://offsite/?region=auto&endpoint=https://abc123.r2.cloudflarestorage.com",
    );
    expect(
      within(dialog).getByText("The endpoint is https://abc123.r2.cloudflarestorage.com."),
    ).toBeTruthy();

    // MinIO: an endpoint URL and path-style requests.
    await user.selectOptions(within(dialog).getByLabelText("Provider"), "minio");
    await user.type(within(dialog).getByLabelText("Endpoint URL"), "http://minio:9000");
    expect(resultingUrl(dialog)).toBe(
      "s3://offsite/?endpoint=http://minio:9000&forcePathStyle=true",
    );

    // Anything else: endpoint, optional region and a path-style checkbox.
    await user.selectOptions(within(dialog).getByLabelText("Provider"), "other");
    await user.type(within(dialog).getByLabelText("Region (optional)"), "zone-1");
    await user.click(within(dialog).getByLabelText("Path-style requests"));
    expect(resultingUrl(dialog)).toBe(
      "s3://offsite/?region=zone-1&endpoint=http://minio:9000&forcePathStyle=true",
    );

    await openStep(user, dialog, "Sign in");
    await user.type(within(dialog).getByLabelText("Access key ID"), "K");
    await user.type(within(dialog).getByLabelText("Secret access key"), "S");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toMatchObject({
      url: "s3://offsite/?region=zone-1&endpoint=http://minio:9000&forcePathStyle=true",
      credentials: { AWS_ACCESS_KEY_ID: "K", AWS_SECRET_ACCESS_KEY: "S" },
    });
  });

  it("adds a local folder, which takes no credentials", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "local");
    expect(within(dialog).getByText(/Local folders need no credentials/)).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    // Nothing to sign in with: that step is locked and the save button is right here.
    expect(stepTab(dialog, "Sign in").getAttribute("aria-disabled")).toBe("true");
    expect(stepTab(dialog, "Sign in").textContent).toContain("Not needed");
    expect(within(dialog).queryByRole("button", { name: /Next/ })).toBeNull();
    await user.type(within(dialog).getByLabelText("Folder"), "../etc");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText(/must stay inside the data volume/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText("Folder"));
    await user.type(within(dialog).getByLabelText("Folder"), "backups/prod");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toEqual({
      name: "New place",
      url: "backups/prod",
      credentials: {},
    });
  });

  it("adds Google Cloud Storage with a service account key file", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "gcs");
    await user.type(within(dialog).getByLabelText("Bucket"), "acme-gcs");
    await user.type(within(dialog).getByLabelText("Project ID (optional)"), "acme-prod");
    expect(resultingUrl(dialog)).toBe("gs://acme-gcs/?projectId=acme-prod");

    await openStep(user, dialog, "Sign in");
    const keyField = within(dialog).getByLabelText("Service account key (JSON)");
    await user.type(keyField, "not json");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText(/This is not a JSON key file/)).toBeTruthy();

    const json = '{"type":"service_account","project_id":"acme-prod"}';
    await user.upload(
      within(dialog).getByLabelText("Choose a file for Service account key (JSON)"),
      new File([json], "key.json", { type: "application/json" }),
    );
    expect(await within(dialog).findByDisplayValue(json)).toBe(keyField);
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toEqual({
      name: "New place",
      url: "gs://acme-gcs/?projectId=acme-prod",
      credentials: { GOOGLE_CREDENTIALS_JSON: json },
    });
  });

  it("adds Azure Blob Storage with an account key or a connection string", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "azure");
    // "Sign in" is closed while Location is incomplete: clicking it stays on Location.
    await openStep(user, dialog, "Sign in");
    expect(stepTab(dialog, "Location").getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByText("Enter the storage account name.")).toBeTruthy();
    expect(within(dialog).getByText("Enter the container name.")).toBeTruthy();
    // Focus on the first field with a problem.
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Storage account"));

    await user.type(within(dialog).getByLabelText("Storage account"), "acmebackups");
    await user.type(within(dialog).getByLabelText("Container"), "mongodb");
    await user.type(within(dialog).getByLabelText("Folder in the container (optional)"), "prod/");
    expect(resultingUrl(dialog)).toBe("az://acmebackups/mongodb/prod/");

    await openStep(user, dialog, "Sign in");
    // A connection string for another account is refused before saving.
    await user.click(within(dialog).getByRole("radio", { name: /Connection string/ }));
    await user.type(
      within(dialog).getByLabelText("Azure connection string"),
      "AccountName=elsewhere;AccountKey=K",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(
      within(dialog).getByText(/is for the account “elsewhere”, not “acmebackups”/),
    ).toBeTruthy();

    // The account key is the simple way: it becomes a connection string for the account.
    await user.click(within(dialog).getByRole("radio", { name: /Account key/ }));
    await user.type(within(dialog).getByLabelText("Storage account key"), "c2VjcmV0==");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toEqual({
      name: "New place",
      url: "az://acmebackups/mongodb/prod/",
      credentials: {
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=acmebackups;AccountKey=c2VjcmV0==;EndpointSuffix=core.windows.net",
      },
    });
  });

  it("adds an SFTP server with a private key and its host fingerprint", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "sftp");
    await user.type(within(dialog).getByLabelText("User"), "backup");
    await user.type(within(dialog).getByLabelText("Host"), "vault.example.com");
    await user.type(within(dialog).getByLabelText("Port"), "2222");
    await user.type(within(dialog).getByLabelText("Folder on the server"), "~/mongo");
    expect(resultingUrl(dialog)).toBe("sftp://backup@vault.example.com:2222/~/mongo");

    await openStep(user, dialog, "Sign in");
    await user.type(within(dialog).getByLabelText("SSH private key"), "ssh-ed25519 AAAA public");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(
      within(dialog).getByText(/including the -----BEGIN … PRIVATE KEY----- line/),
    ).toBeTruthy();
    // A stored key is checked against a fingerprint, so one is required.
    expect(
      within(dialog).getByText(/ssh-keyscan -p 2222 vault.example.com \| ssh-keygen -lf -/),
    ).toBeTruthy();

    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----";
    await user.upload(
      within(dialog).getByLabelText("Choose a file for SSH private key"),
      new File([key], "id_ed25519"),
    );
    await within(dialog).findByDisplayValue(/BEGIN OPENSSH/);
    await user.type(within(dialog).getByLabelText("Key passphrase (optional)"), "pw");
    // The fingerprint is a location field: the save above jumped back there for it.
    expect(stepTab(dialog, "Location").getAttribute("aria-selected")).toBe("true");
    await user.type(within(dialog).getByLabelText("Host key fingerprint"), FINGERPRINT);
    await openStep(user, dialog, "Sign in");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toEqual({
      name: "New place",
      url: `sftp://backup@vault.example.com:2222/~/mongo?fingerprint=${FINGERPRINT}`,
      credentials: { SFTP_PRIVATE_KEY: `${key}\n`, SFTP_PASSPHRASE: "pw" },
    });
  });

  it("warns when SFTP host keys are not checked, and needs no fingerprint then", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "sftp");
    await user.type(within(dialog).getByLabelText("User"), "u");
    await user.type(within(dialog).getByLabelText("Host"), "h");
    await user.type(within(dialog).getByLabelText("Folder on the server"), "/srv");
    await user.click(within(dialog).getByLabelText("Accept any host key (unsafe)"));
    expect(within(dialog).getByText("The server's identity is not checked")).toBeTruthy();
    // The console's environment (agent / key file) needs no stored key.
    await openStep(user, dialog, "Sign in");
    await user.click(within(dialog).getByRole("radio", { name: /The console's environment/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toMatchObject({ url: "sftp://u@h/srv?allowUnknownHostKey=true" });
  });
});

describe("storage dialog: editing", () => {
  it("opens an existing URL in its fields and saves it unchanged when untouched", async () => {
    const { user, dialog, backend } = await openEditDialog("S3 primary");
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("s3");
    expect(within(dialog).getByLabelText("Bucket")).toHaveProperty("value", "acme-backups");
    expect(within(dialog).getByLabelText("Folder in the bucket (optional)")).toHaveProperty(
      "value",
      "prod/",
    );
    expect((within(dialog).getByLabelText("Region") as HTMLSelectElement).value).toBe("");
    expect(resultingUrl(dialog)).toBe("s3://acme-backups/prod/");

    // Replacing the stored keys sends the new ones.
    await openStep(user, dialog, "Sign in");
    await user.click(within(dialog).getByRole("radio", { name: /Access keys/ }));
    await user.type(within(dialog).getByLabelText("Access key ID"), "AKIA2");
    await user.type(within(dialog).getByLabelText("Secret access key"), "new");
    await user.click(within(dialog).getByRole("button", { name: "Save and test" }));
    await screen.findByRole("dialog", { name: "Storage test: S3 primary" });
    expect(requestsTo(backend, "PUT", "/api/storage/st-s3").at(-1)?.body).toEqual({
      name: "S3 primary",
      url: "s3://acme-backups/prod/",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA2", AWS_SECRET_ACCESS_KEY: "new" },
    });
  });

  it("opens a region that is not in the list as another region", async () => {
    const { dialog } = await openEditDialog("Tokyo", (mock) => {
      mock.data.storage.push({
        id: "st-tokyo",
        name: "Tokyo",
        url: "s3://acme-jp/?region=ap-southeast-7",
        credentials: {},
        createdAt: new Date().toISOString(),
        objectLock: false,
      });
    });
    expect((within(dialog).getByLabelText("Region") as HTMLSelectElement).value).toBe("*other*");
    expect(within(dialog).getByLabelText("Region code")).toHaveProperty("value", "ap-southeast-7");
    // No stored credentials: nothing to keep.
    expect(within(dialog).queryByRole("radio", { name: /Keep the stored/ })).toBeNull();
  });

  it("cannot keep credentials of another type and clears them for a local folder", async () => {
    const { user, dialog, backend } = await openEditDialog("S3 primary");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "gcs");
    await openStep(user, dialog, "Sign in");
    expect(within(dialog).queryByRole("radio", { name: /Keep the stored/ })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /Service account key/ })).toHaveProperty(
      "checked",
      true,
    );
    await openStep(user, dialog, "Location");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "local");
    await user.type(within(dialog).getByLabelText("Folder"), "archive");
    await user.click(within(dialog).getByRole("button", { name: "Save and test" }));
    await screen.findByRole("dialog", { name: "Storage test: S3 primary" });
    expect(requestsTo(backend, "PUT", "/api/storage/st-s3").at(-1)?.body).toEqual({
      name: "S3 primary",
      url: "archive",
      credentials: {},
    });
  });

  it("opens URLs the fields cannot show in URL mode, and keeps them there", async () => {
    const { user, dialog, backend } = await openEditDialog("Demo", (mock) => {
      mock.data.storage.push({
        id: "st-demo",
        name: "Demo",
        url: "memory://demo",
        credentials: {},
        createdAt: new Date().toISOString(),
        objectLock: false,
      });
    });
    const toggle = within(dialog).getByLabelText("Edit as URL (advanced)");
    expect(toggle).toHaveProperty("checked", true);
    expect(within(dialog).getByLabelText("Location URL")).toHaveProperty("value", "memory://demo");
    expect(within(dialog).getByText("This kind of storage takes no credentials.")).toBeTruthy();

    await user.click(toggle);
    expect(within(dialog).getByText(/This URL cannot be shown as fields/)).toBeTruthy();
    expect(toggle).toHaveProperty("checked", true);
    // Typing clears the explanation.
    await user.type(within(dialog).getByLabelText("Location URL"), "-2");
    expect(within(dialog).queryByText(/This URL cannot be shown as fields/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save and test" }));
    await screen.findByRole("dialog", { name: "Storage test: Demo" });
    expect(requestsTo(backend, "PUT", "/api/storage/st-demo").at(-1)?.body).toEqual({
      name: "Demo",
      url: "memory://demo-2",
      credentials: {},
    });
  });

  it("switches between the fields and the URL in both directions", async () => {
    const { user, dialog } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    const raw = within(dialog).getByLabelText("Location URL");
    // The URL starts as what the fields built.
    expect(raw).toHaveProperty("value", "s3://acme/");
    await user.clear(raw);
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText(/Enter a URL such as/)).toBeTruthy();

    await user.type(raw, "gs://other/x?projectId=p");
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("gcs");
    expect(within(dialog).getByLabelText("Bucket")).toHaveProperty("value", "other");
    expect(within(dialog).getByLabelText("Project ID (optional)")).toHaveProperty("value", "p");

    // An empty URL simply goes back to the fields as they were.
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    await user.clear(within(dialog).getByLabelText("Location URL"));
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    expect(within(dialog).getByLabelText("Bucket")).toHaveProperty("value", "other");

    // An AWS region typed in the URL that is not in the list opens as "Other region…".
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    await user.clear(within(dialog).getByLabelText("Location URL"));
    await user.type(within(dialog).getByLabelText("Location URL"), "s3://b/?region=xx-1");
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    expect(within(dialog).getByLabelText("Region code")).toHaveProperty("value", "xx-1");
  });

  it("accepts Azure account keys in URL mode for the URL's account", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    const raw = within(dialog).getByLabelText("Location URL");
    await user.clear(raw);
    await user.type(raw, "az://acct/c?retention=governance");
    await openStep(user, dialog, "Sign in");
    await user.type(within(dialog).getByLabelText("Storage account key"), "K");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    await screen.findByRole("dialog", { name: "Storage test: New place" });
    expect(lastCreate(backend)).toMatchObject({
      url: "az://acct/c?retention=governance",
      credentials: {
        AZURE_STORAGE_CONNECTION_STRING: expect.stringContaining("AccountName=acct;AccountKey=K"),
      },
    });
  });
});

describe("storage dialog: suggestions", () => {
  /** The chips of one field's suggestion row, by the field's name. */
  function chips(dialog: HTMLElement, field: string) {
    return within(within(dialog).getByRole("group", { name: `Suggestions for ${field}` }));
  }

  it("suggests names from the type and its fields", async () => {
    const { user, dialog } = await openAddDialog();
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    await user.click(chips(dialog, "Name").getByRole("button", { name: "S3 primary" }));
    expect(name.value).toBe("S3 primary");
    expect(
      chips(dialog, "Name")
        .getByRole("button", { name: "S3 primary" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The bucket itself becomes a name too.
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    expect(chips(dialog, "Name").getByRole("button", { name: "acme" })).toBeTruthy();

    // S3-compatible names follow the provider (Cloudflare R2 first).
    await user.selectOptions(within(dialog).getByLabelText("Type"), "s3-compatible");
    await user.click(chips(dialog, "Name").getByRole("button", { name: "R2 offsite" }));
    expect(name.value).toBe("R2 offsite");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "local");
    expect(chips(dialog, "Name").getByRole("button", { name: "Local backups" })).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "sftp");
    await user.type(within(dialog).getByLabelText("Host"), "vault");
    expect(chips(dialog, "Name").getByRole("button", { name: "SFTP vault" })).toBeTruthy();
  });

  it("suggests folders, one per connection, and fills them into the URL", async () => {
    const { user, dialog } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    const prefixes = chips(dialog, "Folder in the bucket");
    expect(prefixes.getByRole("button", { name: "backups/" })).toBeTruthy();
    expect(prefixes.getByRole("button", { name: "prod/" })).toBeTruthy();
    // The console's connections ("Production cluster", "Staging", …) as folder names.
    await user.click(await prefixes.findByRole("button", { name: "production-cluster/" }));
    expect(resultingUrl(dialog)).toBe("s3://acme/production-cluster/");

    // A local folder in the data volume.
    await user.selectOptions(within(dialog).getByLabelText("Type"), "local");
    await user.click(chips(dialog, "Folder").getByRole("button", { name: "backups/staging" }));
    expect(within(dialog).getByLabelText("Folder")).toHaveProperty("value", "backups/staging");
  });

  it("suggests SSH, MinIO and Azure defaults", async () => {
    const { user, dialog } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Type"), "sftp");
    await user.click(chips(dialog, "User").getByRole("button", { name: "backup" }));
    await user.click(chips(dialog, "Port").getByRole("button", { name: "22" }));
    await user.click(
      chips(dialog, "Folder on the server").getByRole("button", { name: "/backups" }),
    );
    expect(within(dialog).getByLabelText("User")).toHaveProperty("value", "backup");
    expect(within(dialog).getByLabelText("Port")).toHaveProperty("value", "22");
    expect(within(dialog).getByLabelText("Folder on the server")).toHaveProperty(
      "value",
      "/backups",
    );

    await user.selectOptions(within(dialog).getByLabelText("Type"), "s3-compatible");
    await user.selectOptions(within(dialog).getByLabelText("Provider"), "other");
    await user.click(
      chips(dialog, "Endpoint URL").getByRole("button", { name: "http://minio:9000" }),
    );
    await user.click(chips(dialog, "Region").getByRole("button", { name: "auto" }));
    expect(within(dialog).getByLabelText("Endpoint URL")).toHaveProperty(
      "value",
      "http://minio:9000",
    );
    expect(within(dialog).getByLabelText("Region (optional)")).toHaveProperty("value", "auto");

    await user.selectOptions(within(dialog).getByLabelText("Type"), "azure");
    await user.click(chips(dialog, "Container").getByRole("button", { name: "backups" }));
    await user.click(
      chips(dialog, "Folder in the container").getByRole("button", { name: "prod/" }),
    );
    await user.click(
      chips(dialog, "Custom endpoint").getByRole("button", { name: "Azurite (local)" }),
    );
    expect(within(dialog).getByLabelText("Custom endpoint (optional)")).toHaveProperty(
      "value",
      "http://127.0.0.1:10000/devstoreaccount1",
    );
  });

  it("never suggests secrets", async () => {
    const { user, dialog } = await openAddDialog();
    // Sign in opens once the location is complete.
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    await openStep(user, dialog, "Sign in");
    const panel = within(dialog).getByRole("tabpanel");
    expect(within(panel).queryAllByRole("group", { name: /^Suggestions/ })).toEqual([]);
  });

  it("builds the suggestion lists", () => {
    expect(folderNameOf("  Production cluster! ")).toBe("production-cluster");
    expect(folderNameOf("***")).toBe("");
    expect(storageNameSuggestions(undefined)).toEqual(["Primary backups", "Offsite backups"]);
    // At most three connections, empty folder names dropped.
    expect(prefixSuggestions(["A", "***", "B", "C"])).toEqual(["backups/", "prod/", "a/", "b/"]);
    expect(localFolderSuggestions(["Shop"])).toEqual(["backups", "backups/prod", "backups/shop"]);
  });
});

describe("storage dialog: local checks", () => {
  it("refuses empty, long and taken names", () => {
    expect(storageNameProblem("  ", [])).toBe("Give the storage a name, e.g. “S3 primary”.");
    expect(storageNameProblem("x".repeat(101), [])).toBe("Use at most 100 characters.");
    expect(storageNameProblem(" S3 primary ", ["S3 primary"])).toBe(
      "Another storage location is already called “S3 primary”. Choose another name.",
    );
    expect(storageNameProblem("Archive", ["S3 primary"])).toBeUndefined();
  });

  it("refuses empty, long and unknown URLs in URL mode", () => {
    expect(advancedUrlProblem("")).toMatch(/^Enter a URL/);
    expect(advancedUrlProblem(`s3://${"b".repeat(1030)}`)).toBe("Use at most 1024 characters.");
    expect(advancedUrlProblem("https://example.com/backups")).toMatch(/^Use s3:\/\//);
    expect(advancedUrlProblem("s3://bucket/?retention=governance")).toBeUndefined();
    expect(advancedUrlProblem("backups/prod")).toBeUndefined();
  });

  it("says when another location already has the name, before saving", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "S3 primary");
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    await user.click(within(dialog).getByRole("button", { name: /Next: Sign in/ }));
    expect(stepTab(dialog, "Location").getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByText(/already called “S3 primary”/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Name"));
    expect(lastCreate(backend)).toBeUndefined();
  });

  it("refuses KEY=value lines without a value before saving", async () => {
    const { user, dialog, backend } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Bucket"), "acme");
    await user.click(within(dialog).getByRole("button", { name: /Next: Sign in/ }));
    await user.click(within(dialog).getByRole("radio", { name: /KEY=value lines/ }));
    await user.type(within(dialog).getByLabelText("Credentials"), "AWS_ACCESS_KEY_ID=");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(
      within(dialog).getByText("“AWS_ACCESS_KEY_ID” has no value after the “=”."),
    ).toBeTruthy();
    expect(lastCreate(backend)).toBeUndefined();
  });
});
