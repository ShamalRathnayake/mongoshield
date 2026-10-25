/**
 * AgeKeyGenerator: the "Generate a key pair" panel under the plan editor's Recipients
 * field ("Who can read the backups").
 *
 * It explains, in plain words, which key goes where, and makes a fresh age key pair in
 * this browser (age-keys.ts, WebCrypto X25519):
 *
 *   - the public key (age1…) goes to the page through `onRecipient`, which puts it in the
 *     Recipients field (the page decides whether to append it or replace one);
 *   - the private key (AGE-SECRET-KEY-1…) is shown once, here only, with "Copy private
 *     key" and "Download as file" (an age key file), and a required "I saved the private
 *     key somewhere safe" box. `onSavedChange` tells the page whether that box is ticked,
 *     so it can hold back saving the plan until it is.
 *
 * The private key is never sent to the server and never stored: it lives in this
 * component's state until the panel goes away. Browsers that cannot make X25519 keys (or
 * pages on plain http://, which get no Web Crypto) see how to make one with
 * `mongoshield keygen` or `age-keygen` instead.
 */

import { useEffect, useId, useRef, useState } from "react";
import {
  type AgeKeyPair,
  AgeKeysUnsupportedError,
  ageKeyFileName,
  ageKeyFileText,
  generateAgeKeyPair,
} from "../age-keys.ts";
import { downloadTextFile } from "../onboarding.ts";
import { Button } from "./button.tsx";
import { copyText } from "./copy-button.tsx";
import { CheckboxField } from "./field.tsx";
import { Icon } from "./icons.tsx";
import { Notice } from "./layout.tsx";
import "./age-key-generator.css";

/** Props for `AgeKeyGenerator`. */
export interface AgeKeyGeneratorProps {
  /**
   * Called with the new public key (age1…) after every generation. `replaces` is the
   * public key generated before it in this panel (undefined the first time): its private
   * key is no longer shown anywhere, so the page should usually swap it out for the new one.
   */
  readonly onRecipient: (recipient: string, replaces: string | undefined) => void;
  /**
   * Called with false right after each generation (a private key is waiting to be saved)
   * and with the box's value whenever "I saved the private key somewhere safe" changes.
   * Not called before the first generation: until then there is nothing to save.
   */
  readonly onSavedChange?: (saved: boolean) => void;
}

/** What the panel is doing: waiting, generating, or why it could not generate. */
type Phase = "idle" | "busy" | "insecure" | "unsupported" | "failed";

/** A generated key pair and when it was made (for the key file's "# created:" line). */
interface ShownKey extends AgeKeyPair {
  readonly created: Date;
}

/** "age1qyqs…x7k2": enough of a public key to recognise it, short enough for a label. */
function shortKey(publicKey: string): string {
  return publicKey.length <= 20 ? publicKey : `${publicKey.slice(0, 10)}…${publicKey.slice(-6)}`;
}

/** The panel. See the file comment for what it does. */
export function AgeKeyGenerator(props: AgeKeyGeneratorProps) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState<ShownKey | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  // The last copy/download outcome, read out by screen readers through role="status".
  const [status, setStatus] = useState("");

  // The callbacks may change on every render of the page; keep the latest without
  // making `generate` depend on them.
  const callbacks = useRef(props);
  callbacks.current = props;

  // A generation that finishes after the panel went away must not touch the page.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Makes a new key pair, hands its public key to the page and shows its private key. */
  const generate = async () => {
    setPhase("busy");
    setStatus("");
    try {
      const keyPair = await generateAgeKeyPair();
      if (!mounted.current) return;
      const previous = shown?.publicKey;
      setShown({ ...keyPair, created: new Date() });
      // A new private key is waiting to be saved: the box starts unticked again.
      setSaved(false);
      setPhase("idle");
      callbacks.current.onRecipient(keyPair.publicKey, previous);
      callbacks.current.onSavedChange?.(false);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof AgeKeysUnsupportedError) {
        setPhase(error.insecureContext ? "insecure" : "unsupported");
      } else {
        setPhase("failed");
      }
    }
  };

  /** Copies the private key, and says whether that worked. */
  const copy = async () => {
    if (shown === undefined) return;
    const ok = await copyText(shown.privateKey);
    if (!mounted.current) return;
    setStatus(
      ok
        ? "Copied the private key. Paste it somewhere safe, like a password manager."
        : "This browser blocked copying. Select the private key above and copy it by hand.",
    );
  };

  /** Downloads the private key as an age key file. */
  const download = () => {
    if (shown === undefined) return;
    const filename = ageKeyFileName(shown.created);
    downloadTextFile(filename, ageKeyFileText(shown, shown.created));
    setStatus(`Downloaded ${filename}. Move it somewhere safe and keep a second copy.`);
  };

  /** Ticks or unticks "I saved the private key somewhere safe". */
  const changeSaved = (checked: boolean) => {
    setSaved(checked);
    callbacks.current.onSavedChange?.(checked);
  };

  const privateKeyId = `${id}-private-key`;
  const cannotGenerate = phase === "insecure" || phase === "unsupported" || phase === "failed";

  return (
    <section className="age-key-generator" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="age-key-generator-title">
        Which key goes here?
      </p>
      <p className="age-key-generator-text">
        A key pair has two halves. The <strong>public key</strong> (<code>age1…</code>) is the one
        to paste here: it is safe to share, and anyone who has it can only lock backups, not open
        them. The <strong>private key</strong> (<code>AGE-SECRET-KEY-1…</code>) is the only thing
        that can read the backups: keep it secret and safe. Keys made with{" "}
        <code>mongoshield keygen</code> or <code>age-keygen</code> work too.
      </p>

      <div className="age-key-generator-actions">
        <Button busy={phase === "busy"} onClick={() => void generate()}>
          <Icon name="key" size={14} />
          {shown === undefined ? "Generate a key pair" : "Generate a new key pair"}
        </Button>
        <span className="age-key-generator-note">
          Made in this browser. The console never sees the private key.
        </span>
      </div>

      {cannotGenerate ? <CannotGenerate phase={phase} /> : null}

      {shown === undefined ? null : (
        <div className="age-key-generator-result">
          <p className="age-key-generator-result-title">
            <span className="age-key-generator-badge" aria-hidden="true">
              !
            </span>
            Save your private key now
          </p>
          <p className="age-key-generator-text">
            It is shown only this once and is <strong>not stored anywhere</strong>: not in the
            console and not in the plan. If you lose it, these backups{" "}
            <strong>cannot be restored</strong>, by you or anyone else.
          </p>
          <p className="age-key-generator-text">
            It belongs to the public key{" "}
            <code className="age-key-generator-public">{shown.publicKey}</code>, which was added to
            the recipients.
          </p>

          <label htmlFor={privateKeyId} className="field-label">
            Private key for {shortKey(shown.publicKey)}
          </label>
          <textarea
            id={privateKeyId}
            className="input textarea age-key-generator-key"
            readOnly
            rows={2}
            spellCheck={false}
            autoComplete="off"
            value={shown.privateKey}
            // Clicking into the box selects the whole key, ready to copy by hand.
            onFocus={(event) => event.currentTarget.select()}
          />

          <div className="age-key-generator-actions">
            <Button size="small" onClick={() => void copy()}>
              <Icon name="copy" size={14} />
              Copy private key
            </Button>
            <Button size="small" onClick={download}>
              <Icon name="download" size={14} />
              Download as file
            </Button>
          </div>
          {/* Always rendered, so screen readers announce each new message in it. */}
          <p className="age-key-generator-status" role="status">
            {status}
          </p>

          <CheckboxField
            label="I saved the private key somewhere safe"
            checked={saved}
            onChecked={changeSaved}
            hint="Required before saving the plan. A password manager or an offline copy works well."
          />
        </div>
      )}
    </section>
  );
}

/** Why no key could be made here, and how to make one on a computer instead. */
function CannotGenerate(props: { phase: Phase }) {
  const reason =
    props.phase === "insecure"
      ? "Browsers only make keys on secure pages. Open the console over HTTPS (or on localhost) to make one here."
      : props.phase === "unsupported"
        ? "This browser cannot make these keys. It needs a recent Chrome or Edge (133 or later), Firefox (130 or later) or Safari (17 or later)."
        : "Something went wrong while making the key.";
  return (
    <Notice tone="warning" title="A key cannot be made in this browser">
      <p>{reason}</p>
      <p>Or make one on your computer with either of these commands:</p>
      <pre className="age-key-generator-commands">
        <code>
          npx mongoshield keygen --output backup-key.txt{"\n"}age-keygen -o backup-key.txt
        </code>
      </pre>
      <p>
        Paste the public key it prints (<code>age1…</code>) here, and keep the file safe: it holds
        the private key.
      </p>
    </Notice>
  );
}
