import { useCallback, useEffect, useState } from "react";
import type { CheckStatus, HealthReport } from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { RadialGauge } from "../components/RadialGauge";
import { ApiError, apiGet, setToken } from "../lib/api";
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
