import { useCallback, useEffect, useState } from "react";
import type {
  OpsClientsReport,
  OpsModelReport,
  OpsSourceDriftReport,
} from "@gbrain-cockpit/shared";
import { authRevokeClientCommand } from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { CopyCommand } from "../components/CopyCommand";
import { DriftCard } from "../components/DriftCard";
import { ApiError, apiGet } from "../lib/api";
import { currentProfile } from "../lib/brain";
import { useI18n } from "../lib/i18n";
import { ModelCard } from "./model-card";

// Admin panel (0.4.x): the management surface proper. Visibility is a
// DEPLOYMENT capability (COCKPIT_ADMIN_TOKEN configured — the server says
// so via /api/profiles adminTier), not a browser state: every read here
// rides the base token; only the grant write asks for the admin token at
// its step-up. One-key management writes stay EXACTLY the union grant-read;
// revoke and every other grant reshaping are copy-commands the owner runs
// on the brain host (owner-presence class — same as trust verbs upstream).
// 0.5.1 adds the model-wiring card here: reads on the base token, the live
// model probe (paid) at the admin step-up like the grant write.

function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
}

export function Admin() {
  const { t } = useI18n();
  const [clients, setClients] = useState<OpsClientsReport | null>(null);
  const [drift, setDrift] = useState<OpsSourceDriftReport | null>(null);
  const [model, setModel] = useState<OpsModelReport | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = useCallback(async () => {
    setBusy(true);
    // all fails-soft — a half-down deployment still shows the other cards
    apiGet<OpsClientsReport>("/api/ops/clients")
      .then(setClients)
      .catch(() => setClients(null));
    apiGet<OpsSourceDriftReport>("/api/ops/sources-drift")
      .then(setDrift)
      .catch(() => setDrift(null));
    apiGet<OpsModelReport>("/api/ops/model")
      .then(setModel)
      .catch(() => setModel(null));
    setBusy(false);
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const rows = clients?.clients ?? [];
  const selfId = clients?.selfClientId;
  // the profile's own resolved CLI command name for owner paste text
  const cliBin = currentProfile()?.cliCommand ?? "gbrain";

  return (
    <section className="panel admin">
      <div className="panel-head">
        <div className="panel-actions">
          <button type="button" onClick={() => void probe()} disabled={busy}>
            {busy ? t("health.loading") : t("health.refresh")}
          </button>
        </div>
      </div>

      <div className="hgrid">
        <div className="hcard span8">
          <p className="cap" title={t("admin.clientsDesc")}>
            {t("admin.clients")}
          </p>
          {!clients || clients.status === "down" ? (
            <>
              <p className="muted small">{t("admin.clientsUnavailable")}</p>
              {clients?.command && (
                <CopyCommand command={clients.command} hint={t("admin.clientsHint")} />
              )}
            </>
          ) : clients.status === "degraded" ? (
            <>
              <p className="muted small">{t("admin.clientsDegraded")}</p>
              {clients.error && (
                <p className="muted small">{firstLine(clients.error)}</p>
              )}
              {clients.command && (
                <CopyCommand command={clients.command} hint={t("admin.clientsHint")} />
              )}
            </>
          ) : rows.length === 0 ? (
            <p className="muted small">{t("admin.clientsEmpty")}</p>
          ) : (
            <>
              {rows.map((c) => {
                const isSelf = c.client_id === selfId;
                const revoked = c.revoked === true;
                const scopes = typeof c.scopes === "string" ? c.scopes : "—";
                const fed = Array.isArray(c.federated_read)
                  ? c.federated_read.filter(
                      (s): s is string => typeof s === "string",
                    )
                  : [];
                const surface =
                  typeof c.surface === "string" ? c.surface : "—";
                return (
                  <div
                    key={c.client_id}
                    className="kv-row"
                    style={
                      isSelf ? { borderLeft: `3px solid ${PALETTE.ok}`, paddingLeft: 8 } : undefined
                    }
                  >
                    <dt>
                      <span className="mono small">{c.client_name || c.client_id}</span>{" "}
                      {isSelf && (
                        <span className="muted small">
                          · {t("admin.selfRow")}
                        </span>
                      )}
                      {revoked && (
                        <span
                          className="muted small"
                          style={{ color: PALETTE.stop }}
                        >
                          {" "}
                          · {t("admin.revokedRow")}
                        </span>
                      )}
                      <br />
                      <span className="muted small mono">
                        {c.client_id}
                      </span>
                      <br />
                      <span className="muted small">
                        {t("admin.scopes")}: {scopes} · {t("admin.surface")}:{" "}
                        {surface} · {t("admin.federatedRead")}:{" "}
                        {fed.length > 0 ? fed.join(", ") : "—"}
                      </span>
                    </dt>
                    <dd>
                      {!revoked && (
                        <details>
                          <summary className="cap">{t("admin.revoke")}</summary>
                          <CopyCommand
                            command={authRevokeClientCommand(
                              cliBin,
                              c.client_id,
                            )}
                            hint={
                              isSelf
                                ? t("admin.revokeSelfHint")
                                : t("admin.revokeHint")
                            }
                          />
                        </details>
                      )}
                    </dd>
                  </div>
                );
              })}
              <p className="muted small">{t("admin.revokeFooter")}</p>
            </>
          )}
        </div>

        <ModelCard model={model} refresh={() => void probe()} />

        <DriftCard drift={drift} refresh={() => void probe()} />
      </div>
    </section>
  );
}
