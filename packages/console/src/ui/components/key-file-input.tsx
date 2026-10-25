/**
 * KeyFileInput: a "Load key from file" button for fields that take age private keys,
 * such as the restore wizard's "Private key (optional)".
 *
 * The chosen file is read here, in the browser (the file itself is not uploaded): every
 * `AGE-SECRET-KEY-1…` line in it goes to `onKeys`, and comments and other lines are
 * skipped, so key files from `mongoshield keygen`, `age-keygen` or the console's own
 * "Download as file" all work. What happens to the keys next is up to the page (the
 * restore wizard sends them with that one restore request, and does not store them).
 *
 * A status line under the button says how many keys were found, or why none were.
 */

import { useId, useRef, useState } from "react";
import { privateKeysFromFileText } from "../age-keys.ts";
import { Button } from "./button.tsx";
import { Icon } from "./icons.tsx";
import "./key-file-input.css";

/** Key files are a few hundred bytes; anything far bigger is the wrong file. */
const MAX_FILE_BYTES = 64 * 1024;

/** Props for `KeyFileInput`. */
export interface KeyFileInputProps {
  /** Receives the private keys found in the chosen file (at least one; in file order). */
  readonly onKeys: (keys: string[]) => void;
  /** The button text; "Load key from file" by default. */
  readonly label?: string;
  readonly disabled?: boolean;
}

/** "1 private key" / "2 private keys". */
function keyCount(count: number): string {
  return count === 1 ? "1 private key" : `${count} private keys`;
}

/** Reads a file as text with FileReader (works in every browser, and in jsdom). */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

/** The button, the hidden file picker it opens, and the outcome line. */
export function KeyFileInput(props: KeyFileInputProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  // What happened with the last file, for the status line.
  const [outcome, setOutcome] = useState<{ tone: "ok" | "error"; text: string } | undefined>(
    undefined,
  );

  /** Reads the chosen file and hands its private keys to the page. */
  const load = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setOutcome({ tone: "error", text: `${file.name} is too big to be an age key file.` });
      return;
    }
    try {
      const keys = privateKeysFromFileText(await readText(file));
      if (keys.length === 0) {
        setOutcome({
          tone: "error",
          text: `No private key (AGE-SECRET-KEY-1…) found in ${file.name}.`,
        });
        return;
      }
      props.onKeys(keys);
      setOutcome({ tone: "ok", text: `Loaded ${keyCount(keys.length)} from ${file.name}.` });
    } catch {
      setOutcome({ tone: "error", text: `${file.name} could not be read.` });
    }
  };

  return (
    <div className="key-file-input">
      {/* The real picker stays hidden; the styled button opens it. */}
      <input
        ref={input}
        id={`${id}-file`}
        type="file"
        accept=".txt,.key,.age,text/plain"
        hidden
        aria-label="Key file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Clear the picker, so choosing the same file again still fires onChange.
          event.currentTarget.value = "";
          if (file !== undefined) void load(file);
        }}
      />
      <Button size="small" disabled={props.disabled} onClick={() => input.current?.click()}>
        <Icon name="open" size={14} />
        {props.label ?? "Load key from file"}
      </Button>
      {/* Always rendered, so screen readers announce each new outcome. */}
      <p
        className={`field-hint ${outcome?.tone === "error" ? "key-file-input-error" : ""}`}
        role="status"
      >
        {outcome?.text ?? ""}
      </p>
    </div>
  );
}
