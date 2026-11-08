import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AuditHistoryReport } from "@gbrain-cockpit/shared";
import { apiGet } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { getAuditLines, subscribeAudit } from "../lib/auditLog";

// 最近裁决 · RECENT VERDICTS — the mini-stamp table under the audit block.
// Session rows come from the in-memory audit store; below it, the SERVER's
// two truths: the JSONL audit tail (every write action, across sessions and
// reloads) and the decided take_proposals rows (acted_at/acted_by — gbrain's
// own record of what became of each proposal). Refreshes ride the same
// cockpit:verdict event the Inbox dispatches after every action.

export function VerdictHistory() {
  const { t } = useI18n();
  const lines = useSyncExternalStore(subscribeAudit, getAuditLines);
  const verdicts = lines.filter((l) => l.meta).slice(-8).reverse();
  const [server, setServer] = useState<AuditHistoryReport | null>(null);

  const loadServer = useCallback(() => {
    apiGet<AuditHistoryReport>("/api/audit-history?limit=12")
      .then(setServer)
      .catch(() => setServer(null));
  }, []);

  useEffect(() => {
    loadServer();
    const onVerdict = () => loadServer();
    window.addEventListener("cockpit:verdict", onVerdict);
    return () => window.removeEventListener("cockpit:verdict", onVerdict);
  }, [loadServer]);

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

      {(server?.audit?.length ?? 0) > 0 && (
        <details className="detail-block">
          <summary className="cap">
            {t("inbox.history.serverAudit")} · {server!.audit.length}
          </summary>
          <table>
            <tbody>
              {server!.audit.map((row, i) => (
                <tr key={`${row.at ?? i}-${i}`}>
                  <td className="mono soft-cell" style={{ width: 120 }}>
                    {String(row.at ?? "").replace("T", " ").slice(5, 16)}
                  </td>
                  <td className="mono">{String(row.action ?? "?")}</td>
                  <td>
                    {row.detail && typeof row.detail === "object"
                      ? Object.entries(row.detail as Record<string, unknown>)
                          .slice(0, 3)
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(" · ")
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {(server?.decided?.length ?? 0) > 0 && (
        <details className="detail-block">
          <summary className="cap">
            {t("inbox.history.decided")} · {server!.decided!.length}
          </summary>
          <table>
            <tbody>
              {server!.decided!.map((row) => (
                <tr key={row.id}>
                  <td className="mono soft-cell" style={{ width: 120 }}>
                    {String(row.acted_at ?? "").replace("T", " ").slice(5, 16)}
                  </td>
                  <td className="mono">#{row.id}</td>
                  <td>
                    <span className="ministamp stop">{String(row.status ?? "?")}</span>{" "}
                    <span className="muted">{row.claim_text.slice(0, 60)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
