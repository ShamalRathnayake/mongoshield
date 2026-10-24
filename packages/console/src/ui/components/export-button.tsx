/**
 * "Export": the current result (filter, sort and projection as applied) as a file.
 *
 * The popover asks for the format (JSON array, JSON Lines, CSV), how many documents
 * (up to the server's cap of 10,000) and, for JSON, relaxed or canonical Extended JSON.
 * The server builds the file (bounded, audited, with the caller's role checked) and the
 * browser offers it as a download from a Blob URL, so nothing goes anywhere else.
 */

import { useState } from "react";
import { EXPORT_MAX_LIMIT, type ExportFormat, type ExportResult } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { formatNumber } from "../format.ts";
import { Button } from "./button.tsx";
import { SelectField } from "./field.tsx";
import { Icon } from "./icons.tsx";
import { Popover, usePopover } from "./popover.tsx";

/** What the user chose. */
export interface ExportChoice {
  readonly format: ExportFormat;
  readonly limit: number;
  readonly ejson: "relaxed" | "canonical";
}

/** Document counts offered (the server allows at most {@link EXPORT_MAX_LIMIT}). */
const LIMITS = ["100", "1000", "10000"] as const;

/**
 * Offers text as a file download. A Blob URL keeps the data inside the browser and works
 * under the console's CSP. Does nothing where Blob URLs are unavailable (old test DOMs).
 */
export function downloadFile(filename: string, content: string, contentType: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The export button and its popover. */
export function ExportButton(props: {
  /** Runs the export on the server. */
  run: (choice: ExportChoice) => Promise<ExportResult>;
  /** Told about the outcome, e.g. with a toast. */
  onDone: (message: string, tone: "success" | "error") => void;
  disabled?: boolean;
}) {
  const popover = usePopover();
  const [format, setFormat] = useState<ExportFormat>("json");
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>("1000");
  const [ejson, setEjson] = useState<"relaxed" | "canonical">("relaxed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.run({
        format,
        limit: Math.min(EXPORT_MAX_LIMIT, Number(limit)),
        ejson,
      });
      downloadFile(result.filename, result.content, result.contentType);
      popover.close();
      props.onDone(
        `Downloaded ${result.filename}: ${formatNumber(result.documents)} ${result.documents === 1 ? "document" : "documents"}${result.truncated ? " (stopped at the limit; there are more)" : ""}.`,
        "success",
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        onClick={popover.open}
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={popover.anchor !== undefined}
      >
        <Icon name="download" size={14} />
        Export
      </Button>
      {popover.anchor === undefined ? null : (
        <Popover
          anchor={popover.anchor}
          label="Export the result"
          onClose={popover.close}
          className="picker"
        >
          <div className="picker-body">
            <p className="picker-intro">
              Downloads the documents of the current query (filter, sort and projection), not just
              this page.
            </p>
            <SelectField<ExportFormat>
              label="Format"
              value={format}
              options={[
                { value: "json", label: "JSON (one array)" },
                { value: "jsonl", label: "JSON Lines (one document per line)" },
                { value: "csv", label: "CSV (nested fields as columns)" },
              ]}
              onValue={setFormat}
            />
            <SelectField<(typeof LIMITS)[number]>
              label="At most"
              value={limit}
              options={LIMITS.map((value) => ({
                value,
                label: `${formatNumber(Number(value))} documents`,
              }))}
              onValue={setLimit}
            />
            {format === "csv" ? null : (
              <SelectField<"relaxed" | "canonical">
                label="Extended JSON"
                value={ejson}
                options={[
                  { value: "relaxed", label: "Relaxed (readable)" },
                  { value: "canonical", label: "Canonical (every type explicit)" },
                ]}
                onValue={setEjson}
              />
            )}
            {error === undefined ? null : (
              <p className="field-error" role="alert">
                <span aria-hidden="true">! </span>
                {error}
              </p>
            )}
            <div className="picker-actions">
              <Button onClick={popover.close}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void start()}>
                Download
              </Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
