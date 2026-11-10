import { useCallback, useRef, useState } from "react";
import type {
  DoctorCheckRow,
  OpsCalibrationReport,
  OpsNightlyReport,
} from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { copyCommandText } from "../lib/clipboard";
import { apiGet } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { firstLine } from "../lib/text";

// 0.5.0 nightly-cycle cards (nightly cycles, visible). Both cards follow the
// Health density discipline: collapsed by default — a summary line plus a
// fold; the fold's first open fetches (never on panel mount), so five new
// ops cards cost nothing until the operator asks. All upstream text
// (message/fix prose, command strings) renders as plain text — never
// innerHTML, never through markdown.

/** chip class per three-state check status (na renders neutral-muted). */
function checkChipClass(status: DoctorCheckRow["status"]): string {
  if (status === "ok") return "chip chip-ok";
  if (status === "warn") return "chip chip-degraded";
  if (status === "fail") return "chip chip-down";
  return "chip";
}

/** "8h ago"-style age from an ISO stamp — plain math, no locale plumbing. */
function ageHours(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 3_600_000;
}

/** fetch-on-first-open fold state shared by both cards. */
function useLazyFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetched = useRef(false);
  const load = useCallback(async () => {
    if (fetched.current) return;
    fetched.current = true;
    setBusy(true);
    try {
      setData(await apiGet<T>(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [url]);
  return { data, error, busy, load };
}

/**
 * The nightly-cycle card: per-source cycle stamps (pg, owner D1) + the
 * doctor nightly set (three-state rows, message verbatim) + per-source
 * run-now copy-commands. A source with no stamp is the honest "never
 * cycled" — neutral text, never red: cockpit has no data distinguishing
 * "excluded by deployment" from "should have run" (the deploy-checkup card
 * carries that conversation).
 */
export function NightlyCard() {
  const { t } = useI18n();
  const { data, error, busy, load } = useLazyFetch<OpsNightlyReport>(
    "/api/ops/nightly",
  );
  const [copied, setCopied] = useState<string | null>(null);

  const checks = data?.doctor?.checks ?? [];
  const worst = checks.reduce<"ok" | "warn" | "fail" | "na">(
    (acc, c) =>
      c.status === "fail"
        ? "fail"
        : c.status === "warn" && acc !== "fail"
          ? "warn"
          : acc,
    "ok",
  );
  const summaryTone =
    data?.status === "down"
      ? t("health.cycle.summaryDown")
      : worst === "fail"
        ? t("health.cycle.summaryFail")
        : worst === "warn"
          ? t("health.cycle.summaryWarn")
          : t("health.cycle.summaryOk");
  const stamps = data?.stamps?.sources ?? [];

  return (
    <div className="hcard span8">
      <p className="cap" title={t("health.cycle.desc")}>
        {t("health.cycle.title")}
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
                : t("health.cycle.summaryFold")
            : summaryTone}
        </summary>
        {error && <p className="error small">{firstLine(error)}</p>}
        {data?.doctor?.status === "down" && (
          <p className="muted small">
            {t("health.cycle.doctorUnavailable")}
            {data.doctor.error ? `: ${data.doctor.error}` : ""}
          </p>
        )}
        {/* per-source stamps — the "did it run" table */}
        {data?.stamps?.status === "down" ? (
          <p className="muted small">
            {t("health.cycle.stampsUnavailable")}
            {data.stamps.error ? `: ${data.stamps.error}` : ""}
          </p>
        ) : stamps.length > 0 ? (
          <dl className="kv">
            {stamps.map((s) => {
              const age = ageHours(s.last_full_cycle_at ?? s.last_source_cycle_at);
              return (
                <div key={s.source_id} className="kv-row">
                  <dt className="mono">{s.source_id}</dt>
                  <dd className="mono">
                    {s.last_full_cycle_at || s.last_source_cycle_at
                      ? `${(s.last_full_cycle_at ?? s.last_source_cycle_at ?? "")
                          .replace("T", " ")
                          .slice(0, 16)}${
                          age !== null
                            ? ` · ${t("health.cycle.ageHours").replace("{n}", String(Math.floor(age)))}`
                            : ""
                        }`
                      : t("health.cycle.neverCycled")}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
        {/* doctor rows — message verbatim, three-state chip */}
        {checks.length > 0 && (
          <div className="cycle-checks">
            {checks.map((c) => (
              <p key={c.name} className="small" title={c.message ?? c.name}>
                <span className={checkChipClass(c.status)}>
                  {c.status === "na" ? t("health.cycle.na") : c.status}
                </span>{" "}
                <span className="mono">{c.name}</span>{" "}
                <span className="muted">
                  {c.message ? c.message.slice(0, 120) : ""}
                </span>
              </p>
            ))}
            {(data?.doctor?.missing ?? []).map((name) => (
              <p key={name} className="small">
                <span className="chip">{t("health.cycle.na")}</span>{" "}
                <span className="mono">{name}</span>{" "}
                <span className="muted">{t("health.cycle.missingNote")}</span>
              </p>
            ))}
          </div>
        )}
        {/* run-now copy-commands — paid action, the why travels with them */}
        {data?.runNow && Object.keys(data.runNow).length > 0 && (
          <details className="detail-block">
            <summary className="cap">{t("health.cycle.runNowFold")}</summary>
            <p className="muted small">{t("health.cycle.runNowConsent")}</p>
            {Object.entries(data.runNow).map(([source, command]) => (
              <p key={source} className="small cmd-row">
                <code className="mono">{command}</code>{" "}
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    void copyCommandText(command).then(() => {
                      setCopied(source);
                      setTimeout(() => setCopied(null), 2000);
                    });
                  }}
                >
                  {copied === source ? t("cmd.copied") : t("cmd.copy")}
                </button>
              </p>
            ))}
            <p className="muted small">{t("health.cycle.runNowVerify")}</p>
          </details>
        )}
      </details>
    </div>
  );
}

/**
 * The calibration card: takes scorecard (accuracy/brier) + the calibration
 * profile + doctor takes_count/takes_weight_grid prose. Both leewin brains
 * probed all-zero/null — the empty state is the REAL first-run experience
 * and teaches what will appear here (four-layer hint #2 applies to cards
 * too, not just queues).
 */
export function CalibrationCard() {
  const { t } = useI18n();
  const { data, error, busy, load } = useLazyFetch<OpsCalibrationReport>(
    "/api/ops/calibration",
  );
  const score = data?.scorecard;
  const hasBets = (score?.total_bets ?? 0) > 0 || (score?.resolved ?? 0) > 0;
  const profile = data?.profile;
  const profileEmpty =
    profile === null || profile === undefined ||
    (typeof profile === "object" && Object.keys(profile as object).length === 0);
  const fmt = (v: number | null | undefined, digits = 2): string =>
    typeof v === "number" ? v.toFixed(digits) : "—";

  return (
    <div className="hcard span4">
      <p className="cap" title={t("health.calibration.desc")}>
        {t("health.calibration.title")}
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
                : t("health.calibration.fold")
            : hasBets
              ? t("health.calibration.summarySome").replace(
                  "{n}",
                  String(score?.resolved ?? 0),
                )
              : t("health.calibration.summaryEmpty")}
        </summary>
        {error && <p className="error small">{firstLine(error)}</p>}
        {!hasBets ? (
          <p className="muted small">{t("health.calibration.empty")}</p>
        ) : (
          <dl className="kv">
            <div className="kv-row">
              <dt>{t("health.calibration.bets")}</dt>
              <dd className="mono">{String(score?.total_bets ?? 0)}</dd>
            </div>
            <div className="kv-row">
              <dt>{t("health.calibration.resolved")}</dt>
              <dd className="mono">{String(score?.resolved ?? 0)}</dd>
            </div>
            <div className="kv-row">
              <dt>{t("health.calibration.accuracy")}</dt>
              <dd className="mono">{fmt(score?.accuracy)}</dd>
            </div>
            <div className="kv-row">
              <dt>{t("health.calibration.brier")}</dt>
              <dd className="mono">{fmt(score?.brier, 3)}</dd>
            </div>
            <div className="kv-row">
              <dt>{t("health.calibration.mcpResolved")}</dt>
              <dd className="mono">{String(score?.mcp_resolved ?? 0)}</dd>
            </div>
          </dl>
        )}
        {profileEmpty ? (
          hasBets ? (
            <p className="muted small">{t("health.calibration.profileEmpty")}</p>
          ) : null
        ) : (
          <details className="detail-block">
            <summary className="cap">{t("health.calibration.profileRaw")}</summary>
            <pre className="mono small">
              {JSON.stringify(profile, null, 2).slice(0, 1200)}
            </pre>
          </details>
        )}
        {(data?.doctor?.checks ?? []).map((c) => (
          <p key={c.name} className="small" title={c.message ?? c.name}>
            <span className={checkChipClass(c.status)}>
              {c.status === "na" ? t("health.cycle.na") : c.status}
            </span>{" "}
            <span className="mono">{c.name}</span>{" "}
            <span className="muted">{c.message ? c.message.slice(0, 100) : ""}</span>
          </p>
        ))}
      </details>
    </div>
  );
}

// re-exported so the tone palette stays reachable for future card tweaks
export { PALETTE };
