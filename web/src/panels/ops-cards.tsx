import { useCallback, useState } from "react";
import type {
  DoctorCheckRow,
  OpsAssetsReport,
  OpsDeployReport,
  WriteConflictsReport,
  WriteRequestsReport,
} from "@gbrain-cockpit/shared";
import { copyCommandText } from "../lib/clipboard";
import { apiGet } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";
import { firstLine } from "../lib/text";
import { checkChipClass, useLazyFetch } from "./nightly-cards";

// 0.5.0 batch-3 Health cards: asset health (doctor assets set), the write
// audit view (existing /api/write-requests + /api/write-conflicts, now with
// a home), and the deploy checkup (writer topology + the generated
// per-source unit text). Same density discipline as batch 1: collapsed by
// default, fetch on first open, plain text everywhere.

function CheckRows({ checks }: { checks: DoctorCheckRow[] }) {
  const { t } = useI18n();
  return (
    <>
      {checks.map((c) => (
        <p key={c.name} className="small" title={c.message ?? c.name}>
          <span className={checkChipClass(c.status)}>
            {c.status === "na" ? t("health.cycle.na") : c.status}
          </span>{" "}
          <span className="mono">{c.name}</span>{" "}
          <span className="muted">{c.message ? c.message.slice(0, 140) : ""}</span>
        </p>
      ))}
    </>
  );
}

/** 3.1 资产健康卡:backup/git/unindexed/ghost — real states, never errors. */
export function AssetCard() {
  const { t } = useI18n();
  const { data, error, busy, load } = useLazyFetch<OpsAssetsReport>(
    "/api/ops/assets",
  );
  const checks = data?.doctor?.checks ?? [];
  const worst = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  return (
    <div className="hcard span8">
      <p className="cap" title={t("health.asset.desc")}>
        {t("health.asset.title")}
      </p>
      <details className="detail-block" onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) void load();
      }}>
        <summary className="cap">
          {data === null
            ? busy
              ? t("common.loading")
              : error
                ? t("health.cycle.summaryDown")
                : t("health.asset.fold")
            : worst === "fail"
              ? t("health.asset.summaryFail")
              : worst === "warn"
                ? t("health.asset.summaryWarn")
                : t("health.asset.summaryOk")}
        </summary>
        {error && <p className="error small">{firstLine(error)}</p>}
        {data?.doctor?.status === "down" && (
          <p className="muted small">
            {t("health.cycle.doctorUnavailable")}
            {data.doctor.error ? `: ${data.doctor.error}` : ""}
          </p>
        )}
        <CheckRows checks={checks} />
        <p className="muted small">{t("health.asset.reading")}</p>
      </details>
    </div>
  );
}

/**
 * 3.2 写路径审计:the token's own write receipts + the repeated-conflict
 * list — both endpoints existed since 0.3.0; this card gives them a home in
 * Health (semantics: the write-receipt family, same panel as the notices).
 */
export function WritesCard() {
  const { t } = useI18n();
  const receipts = useLazyFetch<WriteRequestsReport>("/api/write-requests");
  const conflicts = useLazyFetch<WriteConflictsReport>("/api/write-conflicts");
  const load = useCallback(async () => {
    await Promise.all([receipts.load(), conflicts.load()]);
  }, [receipts, conflicts]);
  const items = receipts.data?.items ?? [];
  const conflictItems = conflicts.data?.items ?? [];
  return (
    <div className="hcard span4">
      <p className="cap" title={t("health.writes.desc")}>
        {t("health.writes.title")}
      </p>
      <details className="detail-block" onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) void load();
      }}>
        <summary className="cap">
          {receipts.data === null && conflicts.data === null
            ? receipts.busy
              ? t("common.loading")
              : receipts.error
                ? t("health.cycle.summaryDown")
                : t("health.writes.fold")
            : t("health.writes.summary")
                .replace("{n}", String(items.length))
                .replace("{c}", String(conflictItems.length))}
        </summary>
        {receipts.error && <p className="error small">{firstLine(receipts.error)}</p>}
        {items.length === 0 && conflictItems.length === 0 ? (
          <p className="muted small">{t("health.writes.empty")}</p>
        ) : (
          <>
            {items.slice(0, 6).map((r, i) => (
              <p key={r.request_id ?? i} className="small mono">
                {(r.status ?? "?") + " · " + (r.slug ?? "?") +
                  (r.created_at ? " · " + r.created_at.replace("T", " ").slice(0, 16) : "")}
              </p>
            ))}
            {conflictItems.length > 0 && (
              <p className="small">
                <span className="chip chip-degraded">{t("health.writes.conflicts")}</span>{" "}
                <span className="mono">
                  {conflictItems
                    .slice(0, 5)
                    .map((c) => (c.source_id ? `${c.source_id}/` : "") + (c.slug ?? "?"))
                    .join(", ")}
                </span>
              </p>
            )}
          </>
        )}
        <p className="muted small">{t("health.writes.note")}</p>
      </details>
    </div>
  );
}

/**
 * 3.3 部署体检卡:writer topology + the generated reference unit text. The
 * text is reference material with a disclaimer — the copy button copies it
 * whole; cockpit never installs units (host operations are the owner's).
 */
export function DeployCard() {
  const { t } = useI18n();
  const { data, error, busy, load } = useLazyFetch<OpsDeployReport>(
    "/api/ops/deploy",
  );
  const [copied, setCopied] = useState(false);
  const bindings = data?.writer?.bindings ?? [];
  return (
    <div className="hcard span8">
      <p className="cap" title={t("health.deploy.desc")}>
        {t("health.deploy.title")}
      </p>
      <details className="detail-block" onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) void load();
      }}>
        <summary className="cap">
          {data === null
            ? busy
              ? t("common.loading")
              : error
                ? t("health.cycle.summaryDown")
                : t("health.deploy.fold")
            : data.writer?.status === "ok"
              ? t("health.deploy.summary")
                  .replace("{n}", String(bindings.length))
                  .replace("{mode}", data.writer.mode ?? "?")
              : t("health.deploy.writerDown")}
        </summary>
        {error && <p className="error small">{firstLine(error)}</p>}
        {data?.writer?.status === "down" && (
          <p className="muted small">
            {t("health.deploy.writerDown")}
            {data.writer.error ? `: ${data.writer.error}` : ""}
          </p>
        )}
        {bindings.length > 0 && (
          <dl className="kv">
            {bindings.map((b, i) => (
              <div key={(b.source_id ?? i) + ""} className="kv-row">
                <dt className="mono">{b.source_id ?? "?"}</dt>
                <dd className="mono">
                  {(b.state ?? "?") +
                    (b.git_durability_state && b.git_durability_state !== "unknown"
                      ? ` · git:${b.git_durability_state}`
                      : "")}
                  {b.local_path ? ` · ${b.local_path}` : ""}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {(data?.notes ?? []).length > 0 && (
          <details className="detail-block">
            <summary className="cap">{t("health.deploy.notes")}</summary>
            {(data?.notes ?? []).map((n) => (
              <p key={n} className="muted small">
                {t(`health.deploy.note.${n}` as MessageKey)}
              </p>
            ))}
          </details>
        )}
        {data?.unitText && (
          <>
            <p className="muted small">{t("health.deploy.disclaimer")}</p>
            <p className="small cmd-row">
              <button
                type="button"
                className="small"
                onClick={() => {
                  void copyCommandText(data.unitText!).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? t("cmd.copied") : t("cmd.copy")}
              </button>
            </p>
            <pre className="mono small">{data.unitText}</pre>
          </>
        )}
      </details>
    </div>
  );
}
