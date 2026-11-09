import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnomaliesReport,
  BrainHealthReport,
  CheckStatus,
  HealthReport,
  OpsDreamRunsReport,
  OpsGrantReadResult,
  OpsSourceDriftReport,
  SourcesStatusReport,
} from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { RadialGauge } from "../components/RadialGauge";
import { CopyCommand } from "../components/CopyCommand";
import { ApiError, apiGet, apiSend, setToken } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";

// The Health panel exercises the whole stack live: auth, the API client, the
// server's health route, the MCP driver, the CLI channel and the read-only
// graph bypass. v5 layout: 12-column hgrid, hard-stat cards, ink-edge radial
// gauges (Maple geometry, Mint Audit restyle) for the channels that expose
// latency, and a dashed-rule safety checklist.

const LATENCY_SCALE_MS = 500;

function statusColor(status: CheckStatus): string {
  if (status === "ok") return PALETTE.ok;
  if (status === "degraded") return PALETTE.warn;
  return PALETTE.stop;
}

export function Health() {
  const { t } = useI18n();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // V1.1 per-source diagnostics (sources_status) — rides the same refresh,
  // fails soft: a missing tool (older gbrain) reads "unavailable", never an
  // error panel
  const [sourcesStatus, setSourcesStatus] = useState<SourcesStatusReport | null>(
    null,
  );
  // 0.3.0: gbrain's own health bands + notices, and find_anomalies — same
  // refresh, same fails-soft contract as the sources card
  const [brainHealth, setBrainHealth] = useState<BrainHealthReport | null>(null);
  const [anomalies, setAnomalies] = useState<AnomaliesReport | null>(null);
  // 0.4.0 ops cards: source-visibility drift + dream proposal activity
  const [drift, setDrift] = useState<OpsSourceDriftReport | null>(null);
  const [dreamRuns, setDreamRuns] = useState<OpsDreamRunsReport | null>(null);

  // probe is dependency-free so switching language (which swaps `t`) does not
  // re-fire the fetch effect; the error is stored raw and translated at render.
  const probe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<HealthReport>("/api/healthz"));
    } catch (err) {
      setReport(null);
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.code})`
          : String(err),
      );
    } finally {
      setBusy(false);
    }
    apiGet<SourcesStatusReport>("/api/sources/status")
      .then(setSourcesStatus)
      .catch(() => setSourcesStatus(null));
    apiGet<BrainHealthReport>("/api/brain-health")
      .then(setBrainHealth)
      .catch(() => setBrainHealth(null));
    apiGet<AnomaliesReport>("/api/anomalies")
      .then(setAnomalies)
      .catch(() => setAnomalies(null));
    apiGet<OpsSourceDriftReport>("/api/ops/sources-drift")
      .then(setDrift)
      .catch(() => setDrift(null));
    apiGet<OpsDreamRunsReport>("/api/ops/dream-runs")
      .then(setDreamRuns)
      .catch(() => setDreamRuns(null));
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const checks = report?.checks;
  const mcp = checks?.mcp;
  const cli = checks?.cli;
  const brain = checks?.brain;
  const pg = checks?.pg;
  const brainCounts = brain?.identity?.counts ?? {};
  const pageCount =
    brainCounts.page_count ??
    (Object.keys(brainCounts).length > 0
      ? brainCounts[Object.keys(brainCounts)[0]!]
      : undefined);

  return (
    <section className="panel health">
      <div className="panel-head">
        <h2>{t("panel.health.title")}</h2>
        <div className="panel-actions">
          <button type="button" onClick={() => void probe()} disabled={busy}>
            {busy ? t("health.loading") : t("health.refresh")}
          </button>
          <button
            type="button"
            onClick={() => {
              // back to the app-level token gate (fresh reload re-checks it)
              setToken(null);
              window.location.reload();
            }}
          >
            {t("health.changeToken")}
          </button>
        </div>
      </div>
      <p className="panel-desc">{t("panel.health.desc")}</p>

      {error && (
        <p className="error" role="alert">
          {t("health.error")}: {error}{" "}
          <button type="button" onClick={() => void probe()}>
            {t("health.retry")}
          </button>
        </p>
      )}
      {busy && !report && <p className="muted">{t("health.loading")}</p>}

      {report && (
        <div className="hgrid">
          <div className="hcard span4">
            <p className="cap">{t("health.overall")}</p>
            <p>
              <span className={`chip chip-${report.status}`}>
                {t(`health.status.${report.status}` as MessageKey)}
              </span>
            </p>
            <dl className="kv">
              <Row label={t("health.cockpit")} value={`v${report.cockpitVersion}`} />
              <Row
                label={t("health.uptime")}
                value={`${Math.floor(report.uptimeMs / 1000)}s`}
              />
              <Row label={t("health.generated")} value={report.generatedAt} />
            </dl>
          </div>

          <div className="hcard span4">
            <p className="cap">{t("health.check.mcp")}</p>
            <div className="gauge-row">
              <RadialGauge
                display={mcp?.latencyMs !== undefined ? String(mcp.latencyMs) : "—"}
                frac={mcp?.latencyMs !== undefined ? mcp.latencyMs / LATENCY_SCALE_MS : 0}
                unit="ms"
                color={statusColor(mcp?.status ?? "down")}
                label={t("health.mcp.latency")}
              />
              <div className="gauge-side">
                <div>
                  <i>●</i> {t(`health.status.${mcp?.status ?? "down"}` as MessageKey)}
                </div>
                {mcp?.whoami?.transport && (
                  <div>
                    {t("health.mcp.transport")}: {String(mcp.whoami.transport)}
                  </div>
                )}
                {mcp?.whoami?.client && (
                  <div>
                    {t("health.mcp.client")}: {mcp.whoami.client}
                  </div>
                )}
                {mcp?.whoami?.scopes && (
                  <div>
                    {t("health.mcp.scopes")}: {mcp.whoami.scopes.join(",")}
                  </div>
                )}
                {mcp?.error && <div className="error">{firstLine(mcp.error)}</div>}
              </div>
            </div>
          </div>

          <div className="hcard span4">
            <p className="cap">{t("health.check.brain")}</p>
            <div className="kpi">
              <span className="n">{pageCount ?? "?"}</span>
              <span className="u">{t("health.brain.pages")}</span>
            </div>
            <dl className="kv">
              {brain?.identity?.name !== undefined && (
                <Row label={t("health.brain.name")} value={String(brain.identity.name)} />
              )}
              {brain?.identity?.version !== undefined && (
                <Row label={t("health.brain.version")} value={String(brain.identity.version)} />
              )}
              {brain?.identity?.engine !== undefined && (
                <Row label={t("health.brain.engine")} value={String(brain.identity.engine)} />
              )}
              {brain?.error && <Row label="" value={firstLine(brain.error)} />}
            </dl>
          </div>

          <div className="hcard span4">
            <p className="cap">{t("health.check.cli")}</p>
            <p>
              <span className={`chip chip-${cli?.status ?? "down"}`}>
                {t(`health.status.${cli?.status ?? "down"}` as MessageKey)}
              </span>
            </p>
            {cli?.bin && (
              <p className="mono small">
                {t("health.cli.bin")}: {cli.bin}
              </p>
            )}
            <p className="muted small">
              {cli?.reason === "binary-not-found"
                ? t("health.cli.missing")
                : cli?.reason === "binary-verified"
                  ? t("health.cli.verified")
                  : t("health.cli.unverified")}
            </p>
          </div>

          <div className="hcard span4">
            <p className="cap">{t("health.check.pg")}</p>
            {pg ? (
              <div className="gauge-row">
                <RadialGauge
                  display={pg.latencyMs !== undefined ? String(pg.latencyMs) : "—"}
                  frac={pg.latencyMs !== undefined ? pg.latencyMs / LATENCY_SCALE_MS : 0}
                  unit="ms"
                  color={statusColor(pg.status)}
                  label={t("health.check.pg")}
                />
                <div className="gauge-side">
                  <div>
                    <i>●</i> {t(`health.status.${pg.status}` as MessageKey)}
                  </div>
                  {pg.error && <div className="error">{firstLine(pg.error)}</div>}
                </div>
              </div>
            ) : (
              <p className="muted small">{t("health.pg.unset")}</p>
            )}
          </div>

          <div className="hcard span4 sources-card">
            <p className="cap" title={t("health.sourcesDesc")}>
              {t("health.check.sources")}
            </p>
            {!sourcesStatus || sourcesStatus.status === "down" ? (
              <p className="muted small">{t("health.sourcesUnavailable")}</p>
            ) : (
              <>
                <dl className="kv">
                  {(sourcesStatus.items ?? []).map((s) => {
                    const pending = (
                      s as {
                        watermark?: { pending?: { count?: number } };
                      }
                    ).watermark?.pending?.count;
                    const state = s.error
                      ? firstLine(String(s.error))
                      : String(s.clone_state ?? "?");
                    return (
                      <Row
                        key={s.id}
                        label={s.id}
                        value={[
                          state,
                          typeof s.last_sync_at === "string"
                            ? s.last_sync_at.slice(0, 10)
                            : "",
                          typeof pending === "number" && pending > 0
                            ? `${t("health.sourcesPending")} ${pending}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    );
                  })}
                </dl>
                {(sourcesStatus.items ?? []).length === 0 && (
                  <p className="muted small">{t("health.sourcesEmpty")}</p>
                )}
              </>
            )}
          </div>

          <div className="hcard span4">
            <p className="cap" title={t("health.brainHealthDesc")}>
              {t("health.brainHealth")}
            </p>
            {!brainHealth || brainHealth.status !== "ok" ? (
              <p className="muted small">{t("health.sourcesUnavailable")}</p>
            ) : (
              <>
                <dl className="kv">
                  {(
                    [
                      ["capacity", t("health.capacity")],
                      ["write_failures", t("health.writeFailures")],
                      ["ghost_pages", t("health.ghostPages")],
                      ["unsearchable", t("health.unsearchable")],
                      ["sync_blocked", t("health.syncBlocked")],
                    ] as const
                  ).map(([k, label]) => {
                    const band = (
                      brainHealth.health as Record<string, unknown> | undefined
                    )?.[k];
                    const text =
                      band !== null && typeof band === "object"
                        ? String(
                            (band as Record<string, unknown>).band ??
                              (band as Record<string, unknown>).status ??
                              "?",
                          )
                        : String(band ?? "—");
                    return <Row key={k} label={label} value={text} />;
                  })}
                </dl>
                {(brainHealth.notices ?? []).length > 0 && (
                  <details className="detail-block">
                    <summary className="cap">
                      {t("health.notices")} · {brainHealth.notices!.length}
                    </summary>
                    {brainHealth.notices!.map((n, i) => (
                      <p key={i} className="muted small">
                        {n.slice(0, 240)}
                      </p>
                    ))}
                  </details>
                )}
              </>
            )}
          </div>

          <div className="hcard span4">
            <p className="cap" title={t("health.anomaliesDesc")}>
              {t("health.anomalies")}
            </p>
            {!anomalies || anomalies.status !== "ok" ? (
              <p className="muted small">{t("health.sourcesUnavailable")}</p>
            ) : (anomalies.items ?? []).length === 0 ? (
              <p className="muted small">{t("health.anomaliesEmpty")}</p>
            ) : (
              <pre className="mono small">
                {JSON.stringify(anomalies.items, null, 2).slice(0, 800)}
              </pre>
            )}
          </div>

          <DriftCard drift={drift} refresh={() => void probe()} />

          <HeartbeatCard runs={dreamRuns} />

          <div className="hcard span8 checklist">
            <p className="cap">{t("health.checklist")}</p>
            <div className="row">
              <span>{t("health.checklist.token")}</span>
              <b className="yes">{t("common.pass")}</b>
            </div>
            <div className="row">
              <span>{t("health.checklist.cli")}</span>
              <b className={cli?.status === "ok" ? "yes" : "no"}>
                {cli?.status === "ok" ? t("common.pass") : t("common.na")}
              </b>
            </div>
            <div className="row">
              <span>{t("health.checklist.pg")}</span>
              <b className={pg ? (pg.status === "ok" ? "yes" : "no") : undefined}>
                {pg
                  ? pg.status === "ok"
                    ? t("common.pass")
                    : t("common.fail")
                  : t("common.na")}
              </b>
            </div>
            <div className="row">
              <span>{t("health.checklist.mcp")}</span>
              <b className={mcp?.status === "ok" ? "yes" : "no"}>
                {mcp?.status === "ok" ? t("common.pass") : t("common.fail")}
              </b>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Errors shown to the browser stay one line — full text is server-log only. */
function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

// --- 0.4.0 ops cards ----------------------------------------------------------

/**
 * Source-visibility drift (0.4.0): the pg bypass sees the whole database,
 * MCP only sees granted sources. Rows with pages but no grant would render
 * nowhere in the app — this card names them and offers the one-click union
 * rescope (admin tier, step-up) or the paste-safe copy-command.
 */
function DriftCard({
  drift,
  refresh,
}: {
  drift: OpsSourceDriftReport | null;
  refresh: () => void;
}) {
  const { t } = useI18n();
  // step-up state lives HERE in memory only — the admin token is never
  // persisted, and it clears with the card (disarm / unmount / reload).
  const [armed, setArmed] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // the Inbox batch-arm precedent: 4s to change your mind
    if (armed) {
      disarmTimer.current = setTimeout(() => setArmed(false), 4000);
    }
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, [armed]);

  const missing = drift?.missing ?? [];
  const pgSources = drift?.pgSources;

  async function grant() {
    setSending(true);
    setActionError(null);
    try {
      const body = await apiSend<OpsGrantReadResult>(
        "/api/ops/grant-read",
        "POST",
        {},
        { token: adminToken },
      );
      setAdminToken(""); // step-up material is single-use by design
      setArmed(false);
      setResult(
        body.added.length === 0
          ? t("health.drift.noop")
          : `${t("health.drift.done")}: ${body.added.join(", ")}`,
      );
      refresh();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? `${err.message} (${err.code})` : String(err),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="hcard span8">
      <p className="cap" title={t("health.driftDesc")}>
        {t("health.drift")}
      </p>
      {!drift || drift.status === "down" ? (
        <p className="muted small">{t("health.drift.unavailable")}</p>
      ) : (
        <>
          <dl className="kv">
            {(pgSources ?? []).map((s) => {
              const isMissing = missing.includes(s.source_id);
              return (
                <div className="kv-row" key={s.source_id}>
                  <dt>
                    {s.source_id}{" "}
                    <span className="muted small">
                      · {s.pages} {t("health.drift.pages")}
                    </span>
                  </dt>
                  <dd
                    className="mono"
                    style={{
                      color: isMissing ? PALETTE.warnStamp : PALETTE.ok,
                    }}
                  >
                    {isMissing ? t("health.drift.missing") : t("health.drift.granted")}
                  </dd>
                </div>
              );
            })}
            {(pgSources ?? []).length === 0 && (
              <p className="muted small">{t("health.drift.emptyPg")}</p>
            )}
          </dl>
          {missing.length > 0 ? (
            <p className="muted small" style={{ color: PALETTE.warnStamp }}>
              {t("health.drift.found")}: {missing.join(", ")}
            </p>
          ) : (
            <p className="muted small">{t("health.drift.ok")}</p>
          )}

          {drift.action.available && missing.length > 0 && (
            <div className="drift-action">
              {!armed ? (
                <button type="button" onClick={() => setArmed(true)}>
                  {t("health.drift.grantBtn")}
                </button>
              ) : (
                <>
                  <input
                    type="password"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    placeholder={t("health.drift.tokenHint")}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="batch-arm"
                    onClick={() => void grant()}
                    disabled={sending || adminToken.length === 0}
                  >
                    {sending ? t("health.drift.sending") : t("health.drift.grantConfirm")}
                  </button>
                </>
              )}
            </div>
          )}
          {!drift.action.available && drift.action.reason && missing.length > 0 && (
            <p className="muted small">
              {drift.action.reason === "cli-unavailable"
                ? t("health.drift.reasonCli")
                : drift.action.reason === "not-oauth-profile"
                  ? t("health.drift.reasonNotOauth")
                  : t("health.drift.reasonPg")}
            </p>
          )}
          {result && <p className="muted small">{result}</p>}
          {actionError && (
            <p className="error" role="alert">
              {firstLine(actionError)}
            </p>
          )}
          {drift.action.command && missing.length > 0 && (
            <CopyCommand
              command={drift.action.command}
              hint={t("health.drift.cmdHint")}
            />
          )}
          {drift.status === "degraded" && drift.error && (
            <p className="muted small">{firstLine(drift.error)}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Proposal ACTIVITY + upstream's cycle verdict — never claims "dream didn't run". */
function HeartbeatCard({ runs }: { runs: OpsDreamRunsReport | null }) {
  const { t } = useI18n();
  const AMBER_MS = 30 * 3600_000;
  const RED_MS = 54 * 3600_000;
  const last = runs?.lastActivityAt ? Date.parse(runs.lastActivityAt) : null;
  const ageMs = last !== null ? Date.now() - last : null;
  const freshness = runs?.cycleFreshness;
  const freshnessColor =
    freshness?.status === "ok"
      ? PALETTE.ok
      : freshness?.status === "warn"
        ? PALETTE.warn
        : freshness?.status === "fail"
          ? PALETTE.stop
          : undefined;
  return (
    <div className="hcard span4">
      <p className="cap" title={t("health.heartbeatDesc")}>
        {t("health.heartbeat")}
      </p>
      {!runs || runs.status === "down" ? (
        <p className="muted small">{t("health.heartbeat.unavailable")}</p>
      ) : (
        <>
          <dl className="kv">
            <Row
              label={t("health.heartbeat.lastActivity")}
              value={
                runs.neverRan || !runs.lastActivityAt
                  ? t("health.heartbeat.never")
                  : runs.lastActivityAt.replace("T", " ").slice(0, 16)
              }
            />
            <Row
              label={t("health.heartbeat.pending")}
              value={String(runs.pendingTotal ?? 0)}
            />
            {freshness && (
              <Row
                label={t("health.heartbeat.cycle")}
                value={
                  freshness.status === "unknown"
                    ? t("health.heartbeat.cycleUnknown")
                    : freshness.status
                }
              />
            )}
          </dl>
          {ageMs !== null && ageMs > AMBER_MS && (
            <p
              className="muted small"
              style={{ color: ageMs > RED_MS ? PALETTE.stop : PALETTE.warn }}
            >
              {ageMs > RED_MS
                ? t("health.heartbeat.staleRed")
                : t("health.heartbeat.staleAmber")}
            </p>
          )}
          {(runs.runs ?? []).slice(0, 3).map((r) => (
            <p
              key={r.runId}
              className="mono small"
              style={freshnessColor ? { color: freshnessColor } : undefined}
            >
              {r.end.replace("T", " ").slice(0, 16)} · {t("health.heartbeat.takes")}{" "}
              {r.takes} · {t("health.heartbeat.pending")} {r.pending}
            </p>
          ))}
          {freshness?.message && (
            <p className="muted small" title={freshness.message}>
              {freshness.message.slice(0, 140)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
