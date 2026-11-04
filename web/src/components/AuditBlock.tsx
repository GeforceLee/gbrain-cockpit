import { useSyncExternalStore } from "react";
import { useI18n } from "../lib/i18n";
import { getAuditLines, subscribeAudit } from "../lib/auditLog";

// The ink audit block — fixed receipt slot at the bottom of the Inbox detail.
// Newest line glows phosphor; the block cursor keeps blinking like a terminal
// at rest. It never disappears, never times out, never toasts.

export function AuditBlock() {
  const { t } = useI18n();
  const lines = useSyncExternalStore(subscribeAudit, getAuditLines);

  return (
    <div className="audit">
      <div className="cap2">
        <b>{t("audit.title")}</b>
        <span>{t("audit.cap")}</span>
      </div>
      <pre>
        {lines.length === 0 ? (
          <span>{t("audit.empty")}{"\n"}</span>
        ) : (
          lines.map((line, i) => (
            <span key={line.id} className={i === lines.length - 1 ? "new" : ""}>
              {line.at}  {line.text}{"\n"}
            </span>
          ))
        )}
        <span className="cursor">▌</span>
      </pre>
    </div>
  );
}
