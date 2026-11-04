import { useCallback, useEffect, useState } from "react";
import type {
  EdgeProposal,
  InboxReport,
  TakeProposal,
  TrustReviewItem,
} from "@gbrain-cockpit/shared";
import { CopyCommand } from "../components/CopyCommand";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { useI18n } from "../lib/i18n";

// Inbox: the four adjudication queues. The action trichotomy is structural
// (style-review hard constraint): one-key actions are buttons, terminal-
// confirmation actions are ALWAYS copy-command blocks (owner-presence, gbrain
// ENG-15 — never batched, never a button), and when the CLI channel is
// unavailable on this host, CLI one-key actions degrade to copy-command too.
// The takes queue is the propose_takes queue (CLI-only in gbrain 0.60.x):
// LLM-proposed claims waiting for the owner's accept/reject.

/** gbrain review items carry their exact commands when available — prefer them. */
function itemCommand(item: TrustReviewItem, match: string[]): string | null {
  const c = item.commands;
  const candidates: string[] = [];
  if (Array.isArray(c)) {
    candidates.push(...c.filter((x): x is string => typeof x === "string"));
  } else if (c && typeof c === "object") {
    candidates.push(
      ...Object.values(c).filter((x): x is string => typeof x === "string"),
    );
  }
  return (
    candidates.find((cmd) => match.some((m) => cmd.includes(m))) ?? null
  );
}

function itemSummary(item: TrustReviewItem): string {
  for (const key of ["summary", "title", "reason", "claim", "detail"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 300);
  }
  return "";
}

/** Errors shown to the browser stay one line — full text is server-log only. */
function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 220);
}

export function Inbox({ onOpenPage }: { onOpenPage?: (slug: string) => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<InboxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<InboxReport>("/api/inbox"));
    } catch (err) {
      setReport(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(path: string, body: unknown): Promise<boolean> {
    setActionError(null);
    try {
      await apiSend(path, "POST", body);
      await refresh();
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      return false;
    }
  }

  const cliAvailable = report?.cliChannel.available === true;
  const trustItems = report?.trust.items ?? [];
  const proposals = trustItems.filter((i) => (i.ref ?? "").startsWith("tp"));
  const heldWrites = trustItems.filter((i) => (i.ref ?? "").startsWith("h"));
  const facts = trustItems.filter((i) => (i.ref ?? "").startsWith("f"));
  const others = trustItems.filter((i) => {
    const r = i.ref ?? "";
    return r && !r.startsWith("tp") && !r.startsWith("h") && !r.startsWith("f");
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{t("panel.inbox.title")}</h2>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? t("common.loading") : t("health.refresh")}
        </button>
      </div>
      <p className="panel-desc">{t("panel.inbox.desc")}</p>
      <p className={`chip ${cliAvailable ? "chip-ok" : "chip-degraded"}`}>
        {cliAvailable ? t("inbox.cliOk") : t("inbox.cliDegraded")}
      </p>

      {error && <p className="error">{error}</p>}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {!report && !error && <p className="muted">{t("common.loading")}</p>}

      {report && (
        <>
          <TrustQueue
            title={t("inbox.queue.proposals")}
            desc={t("inbox.queue.proposalsDesc")}
            items={proposals}
            status={report.trust.status}
            error={report.trust.error}
            cliAvailable={cliAvailable}
            acceptCommand={(item) =>
              itemCommand(item, ["trust confirm"]) ??
              `gbrain trust confirm ${item.ref}`
            }
            onDrop={(ref) => act("/api/inbox/trust/drop", { ref })}
          />
          <TrustQueue
            title={t("inbox.queue.held")}
            desc={t("inbox.queue.heldDesc")}
            items={heldWrites}
            status={report.trust.status}
            error={report.trust.error}
            cliAvailable={cliAvailable}
            acceptCommand={(item) =>
              itemCommand(item, ["trust release"]) ??
              `gbrain trust release ${item.ref}`
            }
            onDrop={(ref) => act("/api/inbox/trust/drop", { ref })}
          />

          <div className="queue">
            <h3>{t("inbox.queue.facts")}</h3>
            <p className="queue-desc">{t("inbox.queue.factsDesc")}</p>
            {report.trust.status !== "ok" && (
              <p className="muted">
                {t("inbox.queueUnavailable")}: {firstLine(report.trust.error)}
              </p>
            )}
            {report.trust.status === "ok" && facts.length === 0 ? (
              <p className="muted">{t("inbox.empty")}</p>
            ) : (
              facts.map((item) => (
                <div key={item.ref} className="queue-item">
                  <p className="mono small">{item.ref}</p>
                  <p className="queue-summary">{itemSummary(item)}</p>
                  <div className="queue-actions">
                    <button
                      type="button"
                      onClick={() =>
                        void act("/api/inbox/confirm", { ref: item.ref })
                      }
                    >
                      {t("inbox.factConfirm")}
                    </button>
                    {cliAvailable ? (
                      <button
                        type="button"
                        onClick={() =>
                          void act("/api/inbox/trust/drop", { ref: item.ref })
                        }
                      >
                        {t("inbox.factDiscard")}
                      </button>
                    ) : (
                      <CopyCommand command={`gbrain trust drop ${item.ref}`} />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="queue">
            <h3>{t("inbox.queue.edges")}</h3>
            <p className="queue-desc">{t("inbox.queue.edgesDesc")}</p>
            {report.edgeProposals.status !== "ok" && (
              <p className="muted">
                {t("inbox.queueUnavailable")}: {firstLine(report.edgeProposals.error)}
              </p>
            )}
            {report.edgeProposals.status === "ok" &&
              (report.edgeProposals.items ?? []).length === 0 && (
                <p className="muted">{t("inbox.empty")}</p>
              )}
            {(report.edgeProposals.items ?? []).map((p: EdgeProposal) => {
              const id = String(p.id ?? "");
              return (
                <div key={id} className="queue-item">
                  <pre className="mono small queue-raw">{JSON.stringify(p, null, 1)}</pre>
                  <div className="queue-actions">
                    {cliAvailable && id ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void act("/api/inbox/edge", { op: "accept", id })
                          }
                        >
                          {t("inbox.edgeAccept")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void act("/api/inbox/edge", { op: "reject", id })
                          }
                        >
                          {t("inbox.edgeReject")}
                        </button>
                      </>
                    ) : (
                      id && (
                        <CopyCommand
                          command={`gbrain edge-proposals accept ${id}   # 或 reject ${id}`}
                        />
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="queue">
            <h3>{t("inbox.queue.takes")}</h3>
            <p className="queue-desc">{t("inbox.queue.takesDesc")}</p>
            {report.takes.status !== "ok" && (
              <p className="muted">
                {t("inbox.queueUnavailable")}: {firstLine(report.takes.error)}
              </p>
            )}
            {report.takes.status === "ok" &&
              (report.takes.items ?? []).length === 0 && (
                <p className="muted">{t("inbox.empty")}</p>
              )}
            {(report.takes.items ?? []).map((take: TakeProposal) => (
              <div key={take.id} className="queue-item">
                <p className="queue-summary">{take.claim_text}</p>
                <p className="page-meta mono">
                  {take.kind ?? "?"} · {take.holder ?? "?"} ·{" "}
                  {take.weight ?? "?"} · {take.domain ?? "?"}
                  {take.model_id ? ` · ${take.model_id}` : ""}
                </p>
                {onOpenPage && (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onOpenPage(take.page_slug)}
                  >
                    {take.page_slug}
                  </button>
                )}
                <div className="queue-actions">
                  {cliAvailable ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void act("/api/inbox/takes/propose", {
                            op: "accept",
                            id: String(take.id),
                          })
                        }
                      >
                        {t("inbox.edgeAccept")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void act("/api/inbox/takes/propose", {
                            op: "reject",
                            id: String(take.id),
                          })
                        }
                      >
                        {t("inbox.edgeReject")}
                      </button>
                    </>
                  ) : (
                    <CopyCommand
                      command={`gbrain takes propose --accept ${take.id}   # 或 --reject ${take.id}`}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          {others.length > 0 && (
            <div className="queue">
              <h3>{t("inbox.queue.others")}</h3>
              <p className="queue-desc">{t("inbox.queue.othersDesc")}</p>
              {others.map((item) => (
                <div key={item.ref} className="queue-item">
                  <p className="mono small">{item.ref}</p>
                  <p className="queue-summary">{itemSummary(item)}</p>
                  <CopyCommand command={`gbrain trust explain ${item.ref}`} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TrustQueue({
  title,
  desc,
  items,
  status,
  error,
  cliAvailable,
  acceptCommand,
  onDrop,
}: {
  title: string;
  desc: string;
  items: TrustReviewItem[];
  status: "ok" | "degraded" | "down";
  error?: string;
  cliAvailable: boolean;
  /** owner-terminal action — always a copy-command block (ENG-15) */
  acceptCommand: (item: TrustReviewItem) => string;
  onDrop: (ref: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [busyRef, setBusyRef] = useState<string | null>(null);

  return (
    <div className="queue">
      <h3>{title}</h3>
      <p className="queue-desc">{desc}</p>
      {status !== "ok" && (
        <p className="muted">
          {t("inbox.queueUnavailable")}: {firstLine(error)}
        </p>
      )}
      {status === "ok" && items.length === 0 && (
        <p className="muted">{t("inbox.empty")}</p>
      )}
      {items.map((item) => (
        <div key={item.ref} className="queue-item">
          <p className="mono small">{item.ref}</p>
          <p className="queue-summary">{itemSummary(item)}</p>
          <div className="queue-actions">
            {cliAvailable ? (
              <button
                type="button"
                disabled={busyRef === item.ref}
                onClick={async () => {
                  setBusyRef(item.ref ?? null);
                  await onDrop(item.ref ?? "");
                  setBusyRef(null);
                }}
              >
                {t("inbox.drop")}
              </button>
            ) : (
              <CopyCommand command={`gbrain trust drop ${item.ref}`} />
            )}
            {/* accept/release: owner must run it at the brain host terminal */}
            <CopyCommand command={acceptCommand(item)} />
          </div>
        </div>
      ))}
    </div>
  );
}
