import { useEffect, useRef, useState } from "react";
import type {
  DoctorCheckRow,
  OpsModelReport,
  OpsModelTestResult,
} from "@gbrain-cockpit/shared";
import {
  providerBaseUrlSetTemplate,
  providerBaseUrlUnsetCommand,
  providersTestCommand,
} from "@gbrain-cockpit/shared";
import { PALETTE } from "../design/tokens";
import { CopyCommand } from "../components/CopyCommand";
import { ApiError, apiSend } from "../lib/api";
import { currentProfile } from "../lib/brain";
import { useI18n, type MessageKey } from "../lib/i18n";
import { firstLine } from "../lib/text";
import { checkChipClass } from "./nightly-cards";

// The model-wiring card (0.5.1, Admin panel): what the brain's model wiring
// looks like (active models per tier/task, which provider keys are set,
// static provider checks) + the one paid live probe of the ACTIVE path
// (`models doctor` — the same gateway assembly dream uses). Key VALUES
// never appear anywhere: upstream ships booleans only and the server
// picklists on top. Fix guidance is copy-command only — cockpit suggests,
// the owner decides (endpoint choice is the owner's, never pre-filled).

function firstLineOrEmpty(error?: string): string {
  return firstLine(error ?? "");
}

export function ModelCard({
  model,
  refresh,
}: {
  model: OpsModelReport | null;
  refresh: () => void;
}) {
  const { t } = useI18n();
  // step-up state lives HERE in memory only — the admin token is never
  // persisted, and it clears with the card (DriftCard precedent).
  const [armed, setArmed] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [sending, setSending] = useState(false);
  const [test, setTest] = useState<OpsModelTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (armed) {
      disarmTimer.current = setTimeout(() => setArmed(false), 4000);
    }
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, [armed]);

  const cliBin = currentProfile()?.cliCommand ?? "gbrain";
  const wiring = model?.wiring;
  const tiers = wiring?.tiers ?? [];
  const tasks = wiring?.per_task ?? [];
  const checks = model?.doctor?.checks ?? [];

  // provider key presence: env booleans (native) + env_ready options (rest)
  const envKeys = Object.entries(model?.explain?.env_detected ?? {});
  const options = model?.explain?.options ?? [];
  const readyProviders = [
    ...new Set(
      options.filter((o) => o.env_ready === true).map((o) => o.id.split(":")[0]),
    ),
  ];
  const notReadyProviders = [
    ...new Set(
      options.filter((o) => o.env_ready === false).map((o) => o.id.split(":")[0]),
    ),
  ].filter((p) => !readyProviders.includes(p));

  // the ACTIVE chat model → provider prefix for the fix templates
  const activeChat =
    tasks.find((p) => p.key === "models.dream.synthesize")?.resolved ??
    tiers.find((tr) => tr.tier === "reasoning")?.resolved ??
    tiers[0]?.resolved;
  const activeProvider =
    typeof activeChat === "string" && activeChat.includes(":")
      ? activeChat.split(":")[0]
      : undefined;

  // the effective endpoints (pg fixed SELECT overrides); active providers
  // without an override render the honest "default endpoint" line. The one
  // annotation is static teaching copy for the incident's URL pattern —
  // the endpoint is labeled, never the key's type inferred.
  const overrides = model?.urls?.overrides ?? [];
  const overrideRecipes = new Set(overrides.map((o) => o.recipe));
  const wiringProviders = [
    ...new Set(
      [tiers, tasks]
        .flatMap((group) => group.map((r) => r.resolved))
        .filter((id): id is string => typeof id === "string" && id.includes(":"))
        .map((id) => id.slice(0, id.indexOf(":"))),
    ),
  ];
  const activeUncovered = wiringProviders.filter((p) => !overrideRecipes.has(p));
  const channelLabel = (url: string): string | null =>
    url.includes("/api/coding/") ? t("admin.model.urlChannelCoding") : null;

  // dynamic key guidance: which env vars the brain actually consumes
  // (provider_consent.details.provider_env — names, never values)
  const consent = checks.find((c) => c.name === "provider_consent");
  const providerEnv =
    consent?.details && !Array.isArray(consent.details) &&
    Array.isArray((consent.details as Record<string, unknown>).provider_env)
      ? ((consent.details as Record<string, unknown>).provider_env as unknown[])
          .filter((v): v is string => typeof v === "string")
      : [];

  async function runTest() {
    setSending(true);
    setActionError(null);
    try {
      const body = await apiSend<OpsModelTestResult>(
        "/api/ops/model/test",
        "POST",
        {},
        // live probes retry on flaky endpoints — outlive the default 30s
        { token: adminToken, timeoutMs: 60_000 },
      );
      setAdminToken(""); // step-up material is single-use by design
      setArmed(false);
      setTest(body);
      refresh();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? `${err.message} (${err.code})` : String(err),
      );
    } finally {
      setSending(false);
    }
  }

  const worst = checks.reduce<"ok" | "warn" | "fail" | "na">(
    (acc, c) =>
      c.status === "fail"
        ? "fail"
        : c.status === "warn" && acc !== "fail"
          ? "warn"
          : acc,
    "ok",
  );

  return (
    <div className="hcard span8">
      <p className="cap" title={t("admin.model.desc")}>
        {t("admin.model.title")}
      </p>
      {!model || model.status === "down" ? (
        <>
          <p className="muted small">{t("admin.model.unavailable")}</p>
          {model?.explain?.error && (
            <p className="muted small">{firstLineOrEmpty(model.explain.error)}</p>
          )}
        </>
      ) : (
        <>
          {/* the ACTIVE wiring — the models dream will actually call */}
          {wiring?.status === "down" ? (
            <p className="muted small">
              {t("admin.model.wiringUnavailable")}
              {wiring.error ? `: ${firstLineOrEmpty(wiring.error)}` : ""}
            </p>
          ) : tiers.length > 0 ? (
            <dl className="kv">
              {tiers.map((tr, i) => (
                <div className="kv-row" key={(tr.tier ?? i) + ""}>
                  <dt className="mono">{tr.tier ?? "—"}</dt>
                  <dd className="mono">{tr.resolved ?? "—"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted small">{t("admin.model.wiringEmpty")}</p>
          )}
          {tasks.length > 0 && (
            <details className="detail-block">
              <summary className="cap">{t("admin.model.tasksFold")}</summary>
              {tasks.map((p, i) => (
                <p key={(p.key ?? i) + ""} className="small">
                  <span className="mono">{p.key ?? "?"}</span>{" "}
                  <span className="muted">→ {p.resolved ?? "?"}</span>
                </p>
              ))}
            </details>
          )}

          {/* provider key presence — booleans only, values never travel */}
          {model.explain?.status === "down" ? (
            <p className="muted small">
              {t("admin.model.explainUnavailable")}
              {model.explain.error
                ? `: ${firstLineOrEmpty(model.explain.error)}`
                : ""}
            </p>
          ) : (
            <p className="small" style={{ lineHeight: 2 }}>
              {readyProviders.length > 0 && (
                <span>
                  {t("admin.model.keyOk")}:{" "}
                  {readyProviders.map((p) => (
                    <span key={p} className="chip chip-ok">
                      {p}
                    </span>
                  ))}{" "}
                </span>
              )}
              {notReadyProviders.length > 0 && (
                <span>
                  {t("admin.model.keyMissing")}:{" "}
                  {notReadyProviders.map((p) => (
                    <span key={p} className="chip">
                      {p}
                    </span>
                  ))}
                </span>
              )}
              {readyProviders.length === 0 && notReadyProviders.length === 0 && (
                <span className="muted">{t("admin.model.explainEmpty")}</span>
              )}
            </p>
          )}

          {/* the effective endpoints — the URL verdict (pg fixed SELECT) */}
          {model.urls?.status === "down" ? (
            <p className="muted small">
              {t("admin.model.urlsUnavailable")}
              {model.urls.error ? `: ${firstLineOrEmpty(model.urls.error)}` : ""}
            </p>
          ) : (
            <>
              <p className="muted small">{t("admin.model.urlsLead")}</p>
              <dl className="kv">
                {overrides.map((o) => (
                  <div className="kv-row" key={o.recipe}>
                    <dt className="mono">{o.recipe}</dt>
                    <dd className="mono small">
                      {o.url}
                      {channelLabel(o.url)
                        ? ` · ${channelLabel(o.url)}`
                        : ""}
                    </dd>
                  </div>
                ))}
                {activeUncovered.map((p) => (
                  <div className="kv-row" key={p}>
                    <dt className="mono">{p}</dt>
                    <dd className="muted small">{t("admin.model.urlDefault")}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {/* static checks — same three-state rows as the nightly card */}
          {checks.length > 0 && (
            <div className="cycle-checks">
              {checks.map((c) => (
                <p key={c.name} className="small" title={c.message ?? c.name}>
                  <span className={checkChipClass(c.status)}>
                    {c.status === "na" ? t("health.cycle.na") : c.status}
                  </span>{" "}
                  <span className="mono">{c.name}</span>{" "}
                  <span className="muted">
                    {c.message ? c.message.slice(0, 140) : ""}
                  </span>
                </p>
              ))}
              {(model?.doctor?.missing ?? []).map((name) => (
                <p key={name} className="small">
                  <span className="chip">{t("health.cycle.na")}</span>{" "}
                  <span className="mono">{name}</span>{" "}
                  <span className="muted">{t("health.cycle.missingNote")}</span>
                </p>
              ))}
            </div>
          )}

          {/* the live probe — paid, admin step-up, single-flight server-side */}
          <div className="drift-action">
            {!armed ? (
              <button type="button" onClick={() => setArmed(true)}>
                {t("admin.model.testBtn")}
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
                  onClick={() => void runTest()}
                  disabled={sending || adminToken.length === 0}
                >
                  {sending ? t("admin.model.testing") : t("admin.model.testConfirm")}
                </button>
              </>
            )}
          </div>
          <p className="muted small">{t("admin.model.testCost")}</p>
          {test && (
            <div className="cycle-checks">
              <p className="small">
                <span
                  className={
                    test.status === "ok"
                      ? "chip chip-ok"
                      : test.status === "degraded"
                        ? "chip chip-down"
                        : "chip chip-degraded"
                  }
                >
                  {test.status === "ok"
                    ? t("admin.model.testOk")
                    : test.status === "degraded"
                      ? t("admin.model.testFailed")
                      : t("admin.model.testDown")}
                </span>{" "}
                {test.summary && (
                  <span className="muted">
                    {t("admin.model.testSummary")
                      .replace("{ok}", String(test.summary.ok ?? 0))
                      .replace("{n}", String(test.summary.total ?? 0))}
                  </span>
                )}
              </p>
              {(test.probes ?? []).map((p, i) => (
                <p key={i} className="small" title={p.message ?? ""}>
                  <span className={p.status === "ok" ? "chip chip-ok" : "chip chip-down"}>
                    {p.status ?? "?"}
                  </span>{" "}
                  <span className="mono">
                    {(p.model ?? "?") + " · " + (p.touchpoint ?? "?")}
                  </span>{" "}
                  <span className="muted">
                    {p.message ? p.message.slice(0, 120) : ""}
                  </span>
                </p>
              ))}
              {test.status === "down" && test.error && (
                <p className="muted small">{firstLineOrEmpty(test.error)}</p>
              )}
            </div>
          )}
          {actionError && (
            <p className="error" role="alert">
              {firstLineOrEmpty(actionError)}
            </p>
          )}

          {/* fix guidance — copy-command only; the owner decides values */}
          <details className="detail-block">
            <summary className="cap">{t("admin.model.fixFold")}</summary>
            <p className="muted small">{t("admin.model.fixIntro")}</p>
            {providerEnv.length > 0 && (
              <p className="small">
                <span className="mono">{t("admin.model.keyGuide")}</span>{" "}
                <span className="mono">{providerEnv.join(", ")}</span>{" "}
                <span className="muted">~/.gbrain/.env</span>
              </p>
            )}
            {activeProvider && (
              <>
                <CopyCommand
                  command={providerBaseUrlSetTemplate(cliBin, activeProvider)}
                  hint={t("admin.model.setUrlHint")}
                />
                <CopyCommand
                  command={providerBaseUrlUnsetCommand(cliBin, activeProvider)}
                  hint={t("admin.model.unsetUrlHint")}
                />
                {typeof activeChat === "string" && (
                  <CopyCommand
                    command={providersTestCommand(cliBin, activeChat)}
                    hint={t("admin.model.providersTestHint")}
                  />
                )}
              </>
            )}
            {(model?.notes ?? []).length > 0 && (
              <details className="detail-block">
                <summary className="cap">{t("admin.model.notes")}</summary>
                {(model?.notes ?? []).map((n) => (
                  <p key={n} className="muted small">
                    {t(`admin.model.note.${n}` as MessageKey)}
                  </p>
                ))}
              </details>
            )}
          </details>

          {model.status === "degraded" && model.error && (
            <p className="muted small">{firstLineOrEmpty(model.error)}</p>
          )}
          {worst === "warn" && (
            <p className="muted small" style={{ color: PALETTE.warnStamp }}>
              {t("admin.model.checksWarn")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
