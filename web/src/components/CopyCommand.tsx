import { useState } from "react";
import { useI18n } from "../lib/i18n";

// The phosphor command block — the signature component of the action
// trichotomy (style-review hard constraint). Terminal-confirmation and
// copy-command actions render HERE, never as a colored button: the only
// interactive element inside the block is "copy". This is the front half of
// gbrain's ENG-15 owner-presence design; it is a first-class action surface,
// not a degraded fallback, and it is never batched.

export function CopyCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // clipboard API unavailable (non-secure context): select for manual copy
      const range = document.createRange();
      const node = document.getElementById("cmd-" + hash(command));
      if (node) {
        range.selectNodeContents(node);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="cmd-block">
      <div className="cmd-head">
        <span className="cmd-badge">{t("cmd.badge")}</span>
        <button type="button" className="cmd-copy" onClick={() => void copy()}>
          {copied ? t("cmd.copied") : t("cmd.copy")}
        </button>
      </div>
      <code id={"cmd-" + hash(command)}>$ {command}</code>
      <p className="cmd-steps">{t("cmd.steps")}</p>
    </div>
  );
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}
