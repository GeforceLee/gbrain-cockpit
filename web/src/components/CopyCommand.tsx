import { useState } from "react";
import { useI18n } from "../lib/i18n";

// The phosphor command block — the signature component of the action
// trichotomy (style-review hard constraint). Terminal-confirmation and
// copy-command actions render HERE, never as a colored button: the only
// interactive element inside the block is "copy". This is the front half of
// gbrain's ENG-15 owner-presence design; it is a first-class action surface,
// not a degraded fallback, and it is never batched. Ink bg + phosphor text is
// "terminal material": it does not change with the skin.

export function CopyCommand({
  command,
  hint,
}: {
  command: string;
  /** optional one-line hint above the steps (e.g. the sibling command) */
  hint?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);

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
    setFlash(true);
    setTimeout(() => {
      setCopied(false);
      setFlash(false);
    }, 2000);
  }

  return (
    <div className={`cmd ${flash ? "flash" : ""}`}>
      <p className="cap">
        <span>{t("cmd.badge")}</span>
        <span className="zh">{t("cmd.terminal")}</span>
      </p>
      <code id={"cmd-" + hash(command)}>{command}</code>
      {hint ? (
        <p className="steps">
          <b>{hint}</b>
        </p>
      ) : null}
      <p className="steps">
        <b>①</b> {t("cmd.step1")} <b>②</b> {t("cmd.step2")} <b>③</b>{" "}
        {t("cmd.step3")}
      </p>
      <button type="button" className="copybtn" onClick={() => void copy()}>
        {copied ? t("cmd.copied") : t("cmd.copy")}
      </button>
      <p className="nobatch">{t("cmd.nobatch")}</p>
    </div>
  );
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}
