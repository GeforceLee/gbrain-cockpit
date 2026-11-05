import { useSyncExternalStore } from "react";
import { useI18n } from "../lib/i18n";
import { getAuditLines, subscribeAudit } from "../lib/auditLog";

// 最近裁决 · RECENT VERDICTS — the mini-stamp table under the audit block.
// Rows come from the session audit store's structured entries (verdicts and
// writes only); like the audit block it is a fixed record, newest first.

export function VerdictHistory() {
  const { t } = useI18n();
  const lines = useSyncExternalStore(subscribeAudit, getAuditLines);
  const verdicts = lines.filter((l) => l.meta).slice(-8).reverse();

  return (
    <div className="history">
      <div className="head">
        <b>{t("inbox.history.title")}</b>
        <span className="mono">
          {t("inbox.history.session")} · {verdicts.length}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 110 }}>{t("inbox.history.ref")}</th>
            <th>{t("inbox.history.item")}</th>
            <th style={{ width: 110 }}>{t("inbox.history.receipt")}</th>
            <th style={{ width: 88 }}>{t("inbox.history.time")}</th>
            <th style={{ width: 96 }}>{t("inbox.history.result")}</th>
          </tr>
        </thead>
        <tbody>
          {verdicts.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                {t("inbox.history.empty")}
              </td>
            </tr>
          ) : (
            verdicts.map((line) => (
              <tr key={line.id}>
                <td className="mono">{line.meta!.ref}</td>
                <td>{line.meta!.label ?? line.text}</td>
                <td className="mono soft-cell">
                  {line.meta!.receipt ?? "—"}
                </td>
                <td className="mono soft-cell">{line.at}</td>
                <td>
                  <span className={`ministamp ${line.meta!.verdict}`}>
                    {line.meta!.verdictText}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
