import { useEffect, useRef, useState } from "react";
import type {
  OpsGrantReadResult,
  OpsSourceDriftReport,
} from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { CopyCommand } from "./CopyCommand";
import { apiSend } from "../lib/api";
import { stepUpErrorMessage } from "../lib/errors";
import { useI18n } from "../lib/i18n";

// Source-visibility drift (0.4.0): the pg bypass sees the whole database,
// MCP only sees granted sources. Rows with pages but no grant would render
// nowhere in the app — this card names them and offers the one-click union
// rescope (admin tier, step-up) or the paste-safe copy-command.
//
// Rendered by BOTH the Health panel (perception: "why can't I see X") and
// the Admin panel (management: the full grant surface) — one component, so
// the two can never tell different stories about the same drift.

/** Errors shown to the browser stay one line — full text is server-log only. */
function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
}

export function DriftCard({
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
      // long enough to fetch and paste the admin token (4 s closed the
      // prompt mid-paste); unattended, the prompt still clears itself
      disarmTimer.current = setTimeout(() => {
        setArmed(false);
        setAdminToken("");
      }, 120_000);
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
      setArmed(false);
      setResult(
        body.added.length === 0
          ? t("health.drift.noop")
          : `${t("health.drift.done")}: ${body.added.join(", ")}`,
      );
      refresh();
    } catch (err) {
      setActionError(
        stepUpErrorMessage(err, t),
      );
    } finally {
      // single-use by design — on FAILURE too: a kept-alive panel would
      // otherwise re-open the prompt with the admin token still in it
      setAdminToken("");
      setArmed(false);
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
                    type="text"
                    className="token-masked"
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
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      if (disarmTimer.current) clearTimeout(disarmTimer.current);
                      setArmed(false);
                      setAdminToken("");
                    }}
                  >
                    {t("common.cancel")}
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
