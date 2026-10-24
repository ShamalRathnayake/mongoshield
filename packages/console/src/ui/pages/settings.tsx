/**
 * Settings: appearance, the signed-in account, and exporting the console's setup as a
 * `mongoshield.config.ts` (secrets left as environment references) so the same backups
 * can run from the CLI or a CronJob without the console.
 */

import { useState } from "react";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { CodeBlock } from "../components/code-block.tsx";
import { SelectField } from "../components/field.tsx";
import { KeyValueList, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useSession } from "../context.tsx";
import { applyTheme, storedTheme, type ThemeChoice } from "../theme.ts";

/**
 * Offers `content` as a file download. A Blob URL keeps it inside the browser (nothing
 * is sent anywhere) and works under the console's CSP.
 */
export function downloadTextFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The settings page. */
export function SettingsPage() {
  const client = useApi();
  const toast = useToast();
  const { user, session, hasRole } = useSession();
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const [exported, setExported] = useState<{ filename: string; content: string } | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);

  const exportConfig = async () => {
    setBusy(true);
    try {
      const result = await client.call("GET /api/config/export");
      setExported(result);
      downloadTextFile(result.filename, result.content);
      toast.show("success", `Downloaded ${result.filename}.`);
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid-2">
        <Panel title="Appearance">
          <SelectField<ThemeChoice>
            label="Theme"
            value={theme}
            options={[
              { value: "system", label: "Same as the operating system" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValue={(value) => {
              applyTheme(value);
              setTheme(value);
            }}
            hint="Remembered in this browser only."
          />
        </Panel>
        <Panel title="Your account">
          <KeyValueList
            items={[
              ["Username", user?.username ?? "–"],
              ["Role", user?.role ?? "–"],
              ["Sign-in methods", session.authMethods.join(", ")],
            ]}
          />
        </Panel>
      </div>
      <Panel title="Export configuration">
        <p>
          Download the console's connections, storage and plans as a{" "}
          <code>mongoshield.config.ts</code> for the CLI. Secrets are not included: they appear as{" "}
          <code>process.env.…</code> references you fill in yourself.
        </p>
        {hasRole("admin") ? (
          <Button onClick={() => void exportConfig()} busy={busy}>
            Download mongoshield.config.ts
          </Button>
        ) : (
          <Notice tone="info">Only admins can export the configuration.</Notice>
        )}
        {exported === undefined ? null : (
          <CodeBlock label={exported.filename} code={exported.content} />
        )}
      </Panel>
    </>
  );
}
