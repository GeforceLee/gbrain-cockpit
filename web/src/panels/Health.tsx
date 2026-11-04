import { useCallback, useEffect, useState } from "react";
import type { CheckStatus, HealthReport } from "@gbrain-cockpit/shared";
import { ApiError, apiGet, setToken } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";

// The Health panel exercises the whole stack live: auth, the API client, the
// server's health route, the MCP driver, and gbrain serve on the brain host.
// Token entry itself is app-level (TokenGate) — this panel only renders once
// a token is already stored.

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

  return (
    <section className="panel">
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
        <div className="cards">
          <div className="card">
            <h3>{t("health.overall")}</h3>
            <StatusChip status={report.status} />
            <p className="muted mono">
              cockpit v{report.cockpitVersion} · {report.generatedAt}
            </p>
          </div>

          <div className="card">
            <h3>{t("health.check.mcp")}</h3>
            <StatusChip status={report.checks.mcp.status} />
            {report.checks.mcp.error && (
              <p className="error">{report.checks.mcp.error}</p>
            )}
            {report.checks.mcp.whoami && (
              <dl className="kv">
                {report.checks.mcp.whoami.transport !== undefined && (
                  <Row
                    label={t("health.mcp.transport")}
                    value={String(report.checks.mcp.whoami.transport)}
                  />
                )}
                {report.checks.mcp.whoami.client !== undefined && (
                  <Row
                    label={t("health.mcp.client")}
                    value={String(report.checks.mcp.whoami.client)}
                  />
                )}
                {report.checks.mcp.whoami.scopes !== undefined && (
                  <Row
                    label={t("health.mcp.scopes")}
                    value={report.checks.mcp.whoami.scopes.join(", ")}
                  />
                )}
                {report.checks.mcp.latencyMs !== undefined && (
                  <Row
                    label={t("health.mcp.latency")}
                    value={`${report.checks.mcp.latencyMs} ms`}
                  />
                )}
              </dl>
            )}
          </div>

          <div className="card">
            <h3>{t("health.check.brain")}</h3>
            <StatusChip status={report.checks.brain.status} />
            {report.checks.brain.error && (
              <p className="error">{report.checks.brain.error}</p>
            )}
            {report.checks.brain.identity && (
              <dl className="kv">
                {report.checks.brain.identity.name !== undefined && (
                  <Row
                    label={t("health.brain.name")}
                    value={String(report.checks.brain.identity.name)}
                  />
                )}
                {report.checks.brain.identity.version !== undefined && (
                  <Row
                    label={t("health.brain.version")}
                    value={String(report.checks.brain.identity.version)}
                  />
                )}
                {report.checks.brain.identity.engine !== undefined && (
                  <Row
                    label={t("health.brain.engine")}
                    value={String(report.checks.brain.identity.engine)}
                  />
                )}
                {report.checks.brain.identity.counts &&
                  Object.entries(report.checks.brain.identity.counts).map(
                    ([key, value]) => (
                      <Row key={key} label={key} value={String(value)} />
                    ),
                  )}
              </dl>
            )}
          </div>

          <div className="card">
            <h3>{t("health.check.cli")}</h3>
            <StatusChip status={report.checks.cli.status} />
            {report.checks.cli.bin && (
              <p className="mono small">{report.checks.cli.bin}</p>
            )}
            <p className="muted">
              {report.checks.cli.reason === "binary-not-found"
                ? t("health.cli.missing")
                : t("health.cli.unverified")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: CheckStatus }) {
  const { t } = useI18n();
  return (
    <p className="">
      <span className={`chip chip-${status}`}>
        {t(`health.status.${status}` as MessageKey)}
      </span>
    </p>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
