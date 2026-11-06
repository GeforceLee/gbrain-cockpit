import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ADJUDICATION_CHANNELS,
  TRUST_REF_RE,
  edgeAcceptCommand,
  takesAcceptCommand,
  trustConfirmCommand,
  trustDropCommand,
  trustExplainCommand,
  trustReleaseCommand,
} from "@gbrain-cockpit/shared";
import type {
  AdjudicationAction,
  EdgeProposal,
  InboxReport,
  TakeProposal,
  TrustReviewItem,
} from "@gbrain-cockpit/shared";
import { AuditBlock } from "../components/AuditBlock";
import { ChannelMatrixCard, type ChannelRow } from "../components/ChannelMatrixCard";
import { CopyCommand } from "../components/CopyCommand";
import { PageDrawer } from "../components/PageDrawer";
import { Pager, usePageSize } from "../components/Pager";
import { StampButton } from "../components/StampButton";
import { Tag, type TagVariant } from "../components/Tag";
import { TrustChain } from "../components/TrustChain";
import { VerdictHistory } from "../components/VerdictHistory";
import { appendAudit, type AuditMeta } from "../lib/auditLog";
import { copyCommandText } from "../lib/clipboard";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { currentProfile } from "../lib/brain";
import { useI18n, type MessageKey } from "../lib/i18n";
import { isSlugLike } from "../lib/pages";
import { firstLine } from "../lib/text";

// Inbox — the adjudication desk, in the frozen v5 interaction model:
// queue tabs | queue-card list | document + decision rail, with the stamp
// drop as the brand moment and the ink audit block as the fixed receipt
// slot. The action trichotomy is STRUCTURAL (style-review hard constraint):
// one-key actions are stamp buttons, terminal-confirmation actions are
// ALWAYS copy-command blocks (owner-presence, gbrain ENG-15 — never batched,
// never a button), and when the CLI channel is unavailable on this host,
// CLI one-key actions degrade to copy-command blocks too.

type QueueId = "proposals" | "held" | "facts" | "edges" | "takes" | "others";
type TabId = "all" | Exclude<QueueId, "others">;

/** keep-alive refresh threshold: re-fetch the queues once when returning to
 *  the desk after this long away (queue verdicts elsewhere change counts) */
const INBOX_STALE_MS = 60_000;

// Queue cards are paginated (the takes queue alone can hold 500+ items per
// dream run); the page size is user-selectable and persists per browser.

interface Entry {
  key: string;
  queueId: QueueId;
  /** corner badge text (mono) */
  ref: string;
  /** badge emphasis: held writes amber, terminal refs red */
  refClass: "" | "held" | "term";
  title: string;
  sub?: string;
  /** TARGET block in the document head (page slug / edge endpoint) */
  target?: string;
  tags: { variant: TagVariant; text: string }[];
  srcLines: string[];
  item: TrustReviewItem | EdgeProposal | TakeProposal;
}

interface StampState {
  variant: "drop" | "ok";
  zh: string;
  en: string;
}

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

function stringField(item: object, key: string): string | undefined {
  const v = (item as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

// --- owner-terminal command safety -------------------------------------------
// Copy-command blocks are pasted into the owner's shell, so every value we
// interpolate is defense-in-depth validated client-side too (the server's
// drop route applies the same pattern). A malformed ref from a buggy or
// hostile gbrain must never become shell text.

/** trust refs only, by the shared pattern (same as the server route). */
function safeRef(ref: string | undefined): string {
  return ref && TRUST_REF_RE.test(ref) ? ref : "?";
}

/** numeric ids only (edge-proposal / take ids). */
function safeId(id: string | undefined): string {
  return id && /^\d{1,18}$/.test(id) ? id : "?";
}

/**
 * Gate gbrain's own command text before it reaches a copy block: it must be
 * an invocation of THIS brain's command (the profile's bin — on a wrapper
 * brain like `gbrain-bip`, upstream's literal `gbrain …` text would run
 * against the DEFAULT brain: a wrong-brain mutation, so it must fall back)
 * and free of shell metacharacters. The fallback is always the command
 * cockpit builds from validated parts. Do NOT "fix" this back to a bare
 * `gbrain ` prefix — that reintroduces the wrong-brain paste.
 */
function ownerSafeCommand(
  cmd: string | null,
  fallback: string,
  bin: string,
): string {
  if (
    cmd !== null &&
    cmd.startsWith(`${bin} `) &&
    !/[;&|><$`"'\n]/.test(cmd)
  ) {
    return cmd;
  }
  return fallback;
}

export function Inbox({
  active,
  onOpenPage,
  onTotal,
}: {
  /** keep-alive: true while this panel is the visible one */
  active?: boolean;
  onOpenPage?: (slug: string) => void;
  /** sidebar count chip — reported after every fetch, no extra request */
  onTotal?: (total: number) => void;
}) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<InboxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePageSize("cockpit.pagesize.inbox");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [stamp, setStamp] = useState<StampState | null>(null);
  // two-step confirm for the page-level batch reject (takes, CLI channel)
  const [batchArmed, setBatchArmed] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // page reference opened in the shared in-place drawer (never a panel jump)
  const [peekSlug, setPeekSlug] = useState<string | null>(null);
  // keep-alive staleness: when the panel comes back into view older than
  // this, one silent refresh re-syncs the queue (dream runs and verdicts
  // from other surfaces change it while the desk is hidden)
  const fetchedAtRef = useRef(0);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<InboxReport>("/api/inbox"));
      fetchedAtRef.current = Date.now();
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

  useEffect(() => {
    if (
      active &&
      fetchedAtRef.current > 0 &&
      Date.now() - fetchedAtRef.current > INBOX_STALE_MS
    ) {
      void refresh();
    }
  }, [active, refresh]);

  const cliAvailable = report?.cliChannel.available === true;
  // The profile's owner command name — wrapper brains (gbrain-bip) print
  // THEIR name in every copy-command; "gbrain" when unset.
  const cliCommand = report?.cliChannel.command ?? "gbrain";
  const canConfirm = currentProfile()?.canConfirm;
  const trustItems = report?.trust.items ?? [];
  const proposals = trustItems.filter((i) => (i.ref ?? "").startsWith("tp"));
  const heldWrites = trustItems.filter((i) => (i.ref ?? "").startsWith("h"));
  const facts = trustItems.filter((i) => (i.ref ?? "").startsWith("f"));
  const others = trustItems.filter((i) => {
    const r = i.ref ?? "";
    return r && !r.startsWith("tp") && !r.startsWith("h") && !r.startsWith("f");
  });
  const edges = report?.edgeProposals.items ?? [];
  const takes = report?.takes.items ?? [];

  const queueCounts: Record<QueueId, number> = {
    proposals: proposals.length,
    held: heldWrites.length,
    facts: facts.length,
    edges: edges.length,
    takes: takes.length,
    others: others.length,
  };

  // Channel down ≠ queue empty (e.g. gbrain thin-client hosts cannot run the
  // trust CLI family): surface unavailability per queue instead of "empty".
  // The trust queue backs proposals/held/facts/others; edges and takes have
  // their own channels.
  const trustDown =
    report && report.trust.status !== "ok" ? firstLine(report.trust.error) : null;
  const queueDown: Partial<Record<QueueId, string>> = {
    ...(trustDown
      ? { proposals: trustDown, held: trustDown, facts: trustDown, others: trustDown }
      : {}),
    ...(report && report.edgeProposals.status !== "ok"
      ? { edges: firstLine(report.edgeProposals.error) }
      : {}),
    ...(report && report.takes.status !== "ok"
      ? { takes: firstLine(report.takes.error) }
      : {}),
  };
  const downNotices = (tabId: TabId): string[] =>
    tabId === "all"
      ? ([...new Set(Object.values(queueDown).filter(Boolean))] as string[])
      : queueDown[tabId] !== undefined
        ? [queueDown[tabId]!]
        : [];

  useEffect(() => {
    if (!report) return;
    onTotal?.(
      queueCounts.proposals +
        queueCounts.held +
        queueCounts.facts +
        queueCounts.edges +
        queueCounts.takes +
        queueCounts.others,
    );
  }, [report]); // onTotal is a stable state setter from the shell

  // --- entry assembly --------------------------------------------------------

  function trustEntry(queueId: "proposals" | "held" | "facts" | "others", item: TrustReviewItem): Entry {
    const ref = item.ref ?? "?";
    return {
      key: `trust-${ref}`,
      queueId,
      ref,
      refClass: queueId === "held" ? "held" : queueId === "facts" ? "term" : "",
      title: itemSummary(item) || ref,
      sub: stringField(item, "kind"),
      target:
        stringField(item, "target") ??
        stringField(item, "page") ??
        stringField(item, "page_slug") ??
        stringField(item, "path"),
      tags: [
        { variant: "soft", text: t(`inbox.queue.${queueId}` as MessageKey) },
        ...(stringField(item, "kind")
          ? [{ variant: "plain" as TagVariant, text: stringField(item, "kind")! }]
          : []),
      ],
      srcLines: [
        stringField(item, "source") ?? stringField(item, "origin") ?? "",
      ].filter(Boolean),
      item,
    };
  }

  function edgeEntry(p: EdgeProposal): Entry {
    const id = String(p.id ?? "");
    const from = stringField(p, "from_slug") ?? stringField(p, "from") ?? "?";
    const to = stringField(p, "to_slug") ?? stringField(p, "to") ?? "?";
    const rel = stringField(p, "link_type") ?? stringField(p, "relation") ?? "";
    return {
      key: `edge-${id}`,
      queueId: "edges",
      ref: id ? `#${id}` : "edge",
      refClass: "",
      title: `${from} → ${to}`,
      sub: rel,
      target: to,
      tags: [
        { variant: "soft", text: t("inbox.queue.edges") },
        ...(rel ? [{ variant: "plain" as TagVariant, text: rel }] : []),
      ],
      srcLines: [from, to].filter(Boolean),
      item: p,
    };
  }

  function takeEntry(take: TakeProposal): Entry {
    return {
      key: `take-${take.id}`,
      queueId: "takes",
      ref: `#${take.id}`,
      refClass: "",
      title: take.claim_text,
      sub: take.kind,
      target: take.page_slug,
      tags: [
        { variant: "soft", text: t("inbox.queue.takes") },
        ...(take.kind ? [{ variant: "plain" as TagVariant, text: take.kind }] : []),
        ...(take.holder ? [{ variant: "warn" as TagVariant, text: take.holder }] : []),
      ],
      srcLines: [take.page_slug, take.model_id ?? ""].filter(Boolean),
      item: take,
    };
  }

  const allEntries: Entry[] = [
    ...proposals.map((i) => trustEntry("proposals", i)),
    ...heldWrites.map((i) => trustEntry("held", i)),
    ...facts.map((i) => trustEntry("facts", i)),
    ...edges.map(edgeEntry),
    ...takes.map(takeEntry),
    ...others.map((i) => trustEntry("others", i)),
  ];
  const visibleEntries =
    tab === "all" ? allEntries : allEntries.filter((e) => e.queueId === tab);

  const totalPages = Math.max(1, Math.ceil(visibleEntries.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedEntries = visibleEntries.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  // tab switches and refreshed-shorter lists fall back to the last page
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages, tab]);

  // --- actions ----------------------------------------------------------------

  async function act(
    path: string,
    body: unknown,
    auditText: string,
    stampState?: StampState,
    meta?: AuditMeta,
  ): Promise<boolean> {
    setActionError(null);
    try {
      await apiSend(path, "POST", body);
      appendAudit(`${auditText} -> OK`, meta);
      if (stampState) setStamp(stampState);
      await refresh();
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      appendAudit(`${auditText} -> ERR ${firstLine(msg)}`);
      setActionError(msg);
      return false;
    }
  }

  function select(entry: Entry) {
    setDetail(entry);
    setStamp(null);
  }

  // Page-level batch reject (takes tab, CLI one-key channel ONLY — terminal-
  // confirmation actions are never batched, style-review hard constraint).
  // Sequential sends with per-item audit lines; stops at the first failure so
  // the audit trail always tells the truth about how far it got.
  async function batchRejectPage(items: Entry[]) {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchArmed(false);
    setActionError(null);
    let done = 0;
    for (const entry of items) {
      const take = entry.item as TakeProposal;
      try {
        await apiSend("/api/inbox/takes/propose", "POST", {
          op: "reject",
          id: String(take.id),
        });
        appendAudit(`takes.propose.reject ${take.id} -> OK`, {
          ref: String(take.id),
          label: take.claim_text.slice(0, 80),
          verdict: "stop",
          verdictText: t("verdict.rejected"),
        });
        done++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        appendAudit(`takes.propose.reject ${take.id} -> ERR ${firstLine(msg)}`);
        setActionError(msg);
        break;
      }
    }
    setBatchBusy(false);
    if (done > 0) await refresh();
  }

  const tabs: { id: TabId; label: string; n: number }[] = [
    { id: "all", label: t("inbox.tab.all"), n: allEntries.length },
    { id: "proposals", label: t("inbox.queue.proposals"), n: queueCounts.proposals },
    { id: "held", label: t("inbox.queue.held"), n: queueCounts.held },
    { id: "facts", label: t("inbox.queue.facts"), n: queueCounts.facts },
    { id: "edges", label: t("inbox.queue.edges"), n: queueCounts.edges },
    { id: "takes", label: t("inbox.queue.takes"), n: queueCounts.takes },
  ];

  return (
    <section className="panel inbox">
      {/* FIRST child on purpose: the drawer's sticky anchor pins to the
          stage viewport from its natural position — at the panel top it is
          on screen the instant the drawer opens; as the LAST child it would
          render ~2000px below the fold and "nothing would happen" */}
      <PageDrawer
        slug={peekSlug}
        onClose={() => setPeekSlug(null)}
        onEdit={onOpenPage}
      />
      <nav className="tabs" aria-label={t("panel.inbox.title")}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            className={`tab ${tab === tb.id ? "on" : ""}`}
            aria-pressed={tab === tb.id}
            onClick={() => {
              setTab(tb.id);
              setPage(0);
              setBatchArmed(false);
            }}
          >
            {tb.label}{" "}
            <span className="n">
              {tb.id !== "all" && queueDown[tb.id] !== undefined ? "?" : tb.n}
            </span>
          </button>
        ))}
      </nav>

      <div className="inbox-meta">
        <p className="panel-desc">{t("panel.inbox.desc")}</p>
        <div className="list-tools">
          <span
            className={`chip ${cliAvailable ? "chip-ok" : "chip-degraded"}`}
            title={cliAvailable ? t("inbox.cliCold") : undefined}
          >
            {cliAvailable ? t("inbox.cliOk") : t("inbox.cliDegraded")}
          </span>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? t("common.loading") : t("health.refresh")}
          </button>
        </div>
      </div>

      {error && (
        <p className="error inbox-error">
          {t("common.errorLabel")}: {firstLine(error)}
        </p>
      )}
      {actionError && (
        <p className="error inbox-error" role="alert">
          {t("common.errorLabel")}: {firstLine(actionError)}
        </p>
      )}
      {!report && !error && <p className="muted inbox-error">{t("common.loading")}</p>}

      {report && (
        <div className="split">
          <div className="list">
            <div className="list-tools">
              <span className="muted">
                {t("inbox.listCaption")} · {visibleEntries.length}
              </span>
              {tab === "takes" && cliAvailable && pagedEntries.length > 0 && (
                <button
                  type="button"
                  className={batchArmed ? "batch-arm" : ""}
                  disabled={batchBusy}
                  title={t("inbox.cliCold")}
                  onClick={() => {
                    if (batchArmed) {
                      void batchRejectPage(pagedEntries);
                      return;
                    }
                    setBatchArmed(true);
                    setTimeout(() => setBatchArmed(false), 4000);
                  }}
                >
                  {batchBusy
                    ? t("common.loading")
                    : batchArmed
                      ? `${t("inbox.batch.confirm")} · ${pagedEntries.length}`
                      : `${t("inbox.batch.reject")} · ${pagedEntries.length}`}
                </button>
              )}
              {totalPages > 1 && (
                <Pager
                  page={safePage}
                  totalPages={totalPages}
                  size={pageSize}
                  onPage={setPage}
                  onSize={(next) => {
                    setPageSize(next);
                    setPage(0);
                  }}
                />
              )}
            </div>
            {downNotices(tab).map((err, i) => (
              <p key={i} className="muted empty-note">
                {t("inbox.queueUnavailable")}: {err}
              </p>
            ))}
            {tab !== "all" && (
              // the selected queue's one-line self-description (AGENTS.md:
              // every surface carries its own explanation)
              <p className="muted empty-note">
                {t(`inbox.queue.${tab}Desc` as MessageKey)}
              </p>
            )}
            {visibleEntries.length === 0 && downNotices(tab).length === 0 && (
              <p className="muted empty-note">{t("inbox.empty")}</p>
            )}
            {pagedEntries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`qcard ${detail?.key === entry.key ? "sel" : ""}`}
                onClick={() => select(entry)}
              >
                <span className={`ref ${entry.refClass}`}>{entry.ref}</span>
                <span className="head">
                  <span>
                    <span className="title">{entry.title}</span>
                    {entry.sub ? <span className="sub">{entry.sub}</span> : null}
                  </span>
                  {entry.queueId === "takes" || entry.queueId === "edges" ? (
                    <span className="metric">
                      <span className="v">{entry.ref.replace("#", "")}</span>
                      <span className="u">id</span>
                    </span>
                  ) : null}
                </span>
                {entry.tags.length > 0 && (
                  <span className="tags">
                    {entry.tags.map((tg, i) => (
                      <Tag key={i} variant={tg.variant}>
                        {tg.text}
                      </Tag>
                    ))}
                  </span>
                )}
                <span className="foot">
                  <span className="src">{entry.srcLines.join("\n")}</span>
                  {/* 采集→抽取→拦截→owner→生效: trust-family items sit at the
                      owner stage — that is the whole reason this desk exists */}
                  {entry.queueId !== "edges" && entry.queueId !== "takes" ? (
                    <TrustChain stages={5} active={3} />
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="detail grid-paper">
            {detail ? (
              <>
                <div className="doc-layout">
                  <div className={`document ${stamp ? "shake" : ""}`}>
                    <DocumentCard entry={detail} onPeek={setPeekSlug} />
                    {stamp ? (
                      <div className={`big-stamp ${stamp.variant}`}>
                        <span className="zh">{stamp.zh}</span>
                        {locale === "zh-CN" ? (
                          <span className="en">{stamp.en}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <DecisionRail
                    entry={detail}
                    cliAvailable={cliAvailable}
                    cliCommand={cliCommand}
                    canConfirm={canConfirm}
                    act={act}
                  />
                </div>
                <AuditBlock />
                <VerdictHistory />
              </>
            ) : (
              <div className="doc-layout">
                <div className="document">
                  <p className="doc-body muted">{t("inbox.noSelection")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// --- document card -------------------------------------------------------------

function DocumentCard({
  entry,
  onPeek,
}: {
  entry: Entry;
  /** open a page reference in the shared in-place drawer (never a jump) */
  onPeek?: (slug: string) => void;
}) {
  const { t } = useI18n();
  const item = entry.item;

  if (entry.queueId === "edges") {
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{entry.title}</h2>
            <p className="refline mono">{entry.ref} · {t("inbox.queue.edges")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.target")}</div>
            {onPeek && isSlugLike(entry.target) ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() => onPeek(entry.target!)}
              >
                {entry.target}
              </button>
            ) : (
              <b>{entry.target ?? "—"}</b>
            )}
          </div>
        </div>
        <p className="cap">{t("inbox.doc.raw")}</p>
        <pre className="doc-raw">{JSON.stringify(item, null, 2)}</pre>
      </>
    );
  }

  if (entry.queueId === "takes") {
    const take = item as TakeProposal;
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{take.claim_text}</h2>
            <p className="refline mono">take #{take.id} · {t("inbox.queue.takes")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.sourcePage")}</div>
            {onPeek ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() => onPeek(take.page_slug)}
              >
                {take.page_slug}
              </button>
            ) : (
              <b>{take.page_slug}</b>
            )}
            <div className="mono to-cap">take #{take.id}</div>
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">{t("inbox.doc.kind")}</p>
            <p className="v">{take.kind ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.holder")}</p>
            <p className="v">{take.holder ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.weightDomain")}</p>
            <p className="v">{take.weight ?? "?"}</p>
            <p className="s">{take.domain ?? "?"}</p>
          </div>
        </div>
        {(take.model_id || take.proposed_at) && (
          <>
            <p className="cap">{t("inbox.doc.provenance")}</p>
            <p className="doc-body mono small">
              {[take.model_id, take.proposed_at].filter(Boolean).join(" · ")}
            </p>
          </>
        )}
      </>
    );
  }

  // trust queues (proposals / held / facts / others)
  const trust = item as TrustReviewItem;
  const revision =
    stringField(trust, "expected_revision") ?? stringField(trust, "revision");
  return (
    <>
      <div className="doc-head">
        <div>
          <h2>{entry.title}</h2>
          <p className="refline mono">
            {trust.ref} · {t(`inbox.queue.${entry.queueId}` as MessageKey)}
          </p>
        </div>
        <div className="to">
          <div className="mono to-cap">{t("inbox.doc.target")}</div>
          {onPeek && isSlugLike(entry.target) ? (
            <button
              type="button"
              className="linkish to-link"
              onClick={() => onPeek(entry.target!)}
            >
              {entry.target}
            </button>
          ) : (
            <b>{entry.target ?? t("inbox.doc.unknownTarget")}</b>
          )}
          {revision ? <div className="mono to-cap">rev {revision}</div> : null}
        </div>
      </div>
      <div className="meta3">
        <div>
          <p className="k">{t("inbox.doc.ref")}</p>
          <p className="v mono">{trust.ref ?? "?"}</p>
        </div>
        <div>
          <p className="k">{t("inbox.doc.kind")}</p>
          <p className="v">{stringField(trust, "kind") ?? "?"}</p>
        </div>
        <div>
          <p className="k">{t("inbox.doc.source")}</p>
          <p className="v">
            {stringField(trust, "source") ?? stringField(trust, "origin") ?? "—"}
          </p>
        </div>
      </div>
      <p className="cap">{t("inbox.doc.pipeline")}</p>
      <div className="chainbox-row">
        <span className="chainbox ok"><b>dream</b>{t("inbox.chain.collect")}</span>
        <span className="arrow">→</span>
        <span className="chainbox ok"><b>extract</b>{t("inbox.chain.extract")}</span>
        <span className="arrow">→</span>
        <span className="chainbox ok"><b>trust</b>{t("inbox.chain.intercept")}</span>
        <span className="arrow">→</span>
        <span className="chainbox now"><b>owner</b>{t("inbox.chain.owner")}</span>
        <span className="arrow">→</span>
        <span className="chainbox dashed"><b>page</b>{t("inbox.chain.effect")}</span>
      </div>
      {itemSummary(trust) && (
        <>
          <p className="cap">{t("inbox.doc.summary")}</p>
          <p className="doc-body">{itemSummary(trust)}</p>
        </>
      )}
      {trust.commands !== undefined && (
        <>
          <p className="cap">{t("inbox.doc.commands")}</p>
          <pre className="doc-raw">{JSON.stringify(trust.commands, null, 2)}</pre>
        </>
      )}
    </>
  );
}

// --- decision rail ---------------------------------------------------------------

function DecisionRail({
  entry,
  cliAvailable,
  cliCommand,
  canConfirm,
  act,
}: {
  entry: Entry;
  cliAvailable: boolean;
  /** the profile's command name for copy-command templates */
  cliCommand: string;
  /** live whoami capability; undefined = unknown (never guessed) */
  canConfirm?: boolean;
  act: (
    path: string,
    body: unknown,
    auditText: string,
    stampState?: StampState,
    meta?: AuditMeta,
  ) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // The single runtime source of truth for which channel an action travels
  // (shared/ADJUDICATION_CHANNELS) — the check card renders FROM the matrix,
  // so it can never disagree with the code that runs the action.
  const ch = (action: AdjudicationAction): string => ADJUDICATION_CHANNELS[action];

  const label = entry.title.slice(0, 80);
  const metaFor = (
    verdict: "stop" | "ok",
    verdictText: string,
    ref: string,
  ): AuditMeta => ({ ref, label, verdict, verdictText });

  let rail: ReactNode = null;
  let rows: ChannelRow[] = [];
  /** set for terminal-confirmation items: ⌘↵ copies it */
  let acceptCmd: string | null = null;
  /** set when the CLI one-key drop is live: ⌘⌫ runs it */
  let dropRun: (() => Promise<boolean>) | null = null;

  const stampDrop = (
    zhKey: MessageKey,
    enKey: MessageKey,
    how: string,
    run: () => Promise<boolean>,
  ) => (
    <StampButton
      variant="drop"
      zh={t(zhKey)}
      en={t(enKey)}
      how={how}
      onClick={() => void run()}
    />
  );

  const stampOk = (
    zhKey: MessageKey,
    enKey: MessageKey,
    how: string,
    run: () => Promise<boolean>,
  ) => (
    <StampButton
      variant="ok"
      zh={t(zhKey)}
      en={t(enKey)}
      how={how}
      onClick={() => void run()}
    />
  );

  // the green "accept" stamp (mockup .stamp-btn.copy): a copy shortcut for
  // the terminal-confirmation command — the verdict itself still only ever
  // happens at the owner's terminal (ENG-15), never through this click
  const copyStamp = (command: string) => (
    <StampButton
      variant="copy"
      zh={t("inbox.edgeAccept")}
      en={t("stamp.en.accept")}
      how={copied ? t("cmd.copied") : t("inbox.via.copy")}
      onClick={() => {
        void copyCommandText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    />
  );

  const rejectedStamp: StampState = {
    variant: "drop",
    zh: t("stamp.rejected"),
    en: t("stamp.en.rejected"),
  };
  const acceptedStamp: StampState = {
    variant: "ok",
    zh: t("stamp.accepted"),
    en: t("stamp.en.accepted"),
  };
  const confirmedStamp: StampState = {
    variant: "ok",
    zh: t("stamp.confirmed"),
    en: t("stamp.en.confirmed"),
  };

  switch (entry.queueId) {
    case "proposals":
    case "held": {
      const trust = entry.item as TrustReviewItem;
      const ref = safeRef(trust.ref);
      acceptCmd = ownerSafeCommand(
        entry.queueId === "proposals"
          ? itemCommand(trust, ["trust confirm"])
          : itemCommand(trust, ["trust release"]),
        entry.queueId === "proposals"
          ? trustConfirmCommand(cliCommand, ref)
          : trustReleaseCommand(cliCommand, ref),
        cliCommand,
      );
      dropRun = cliAvailable
        ? () =>
            act(
              "/api/inbox/trust/drop",
              { ref: trust.ref },
              `trust.drop ${trust.ref}`,
              rejectedStamp,
              metaFor("stop", t("verdict.rejected"), trust.ref ?? "?"),
            )
        : null;
      rail = (
        <>
          {dropRun
            ? stampDrop("inbox.drop", "stamp.en.drop", t("inbox.via.cliDrop"), dropRun)
            : null}
          {!cliAvailable ? (
            // degrade: one-key drop becomes a copy-command block too
            <CopyCommand command={trustDropCommand(cliCommand, ref)} />
          ) : null}
          {copyStamp(acceptCmd)}
          <CopyCommand command={acceptCmd} />
        </>
      );
      rows = [
        {
          label: t("channel.row.drop"),
          channel: ch("trust.proposal.drop"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: entry.queueId === "proposals" ? t("channel.row.accept") : t("channel.row.release"),
          channel: entry.queueId === "proposals" ? ch("trust.proposal.accept") : ch("held-write.release"),
          verdict: "na",
          note: t("channel.terminal"),
        },
        { label: t("channel.row.mcp"), channel: "mcp", verdict: "na", note: t("channel.none") },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "facts": {
      const trust = entry.item as TrustReviewItem;
      const ref = safeRef(trust.ref);
      rail = (
        <>
          {canConfirm === false ? (
            // known-missing memory_confirm scope: the stamp would only ever
            // 502 — show why instead of a button that cannot succeed
            <p className="confirm-readonly">{t("inbox.confirmReadOnly")}</p>
          ) : (
            stampOk("inbox.factConfirm", "stamp.en.confirm", t("inbox.via.mcp"), () =>
              act(
                "/api/inbox/confirm",
                { ref: trust.ref },
                `memory.confirm ${trust.ref}`,
                confirmedStamp,
                metaFor("ok", t("verdict.confirmed"), trust.ref ?? "?"),
              ),
            )
          )}
          {cliAvailable ? (
            stampDrop(
              "inbox.factDiscard",
              "stamp.en.discard",
              t("inbox.via.cliDrop"),
              (dropRun = () =>
                act(
                  "/api/inbox/trust/drop",
                  { ref: trust.ref },
                  `trust.drop ${trust.ref}`,
                  rejectedStamp,
                  metaFor("stop", t("verdict.rejected"), trust.ref ?? "?"),
                )),
            )
          ) : (
            <CopyCommand command={trustDropCommand(cliCommand, ref)} />
          )}
        </>
      );
      rows = [
        {
          label: t("channel.row.confirm"),
          channel: ch("memory.confirm"),
          // A read-grant profile (no memory_confirm scope) can never one-key
          // confirm — say na, and the note below explains the asymmetry:
          // this gates the MCP credential only, never the host CLI.
          verdict: canConfirm === false ? "na" : "yes",
          note:
            canConfirm === false
              ? t("inbox.confirmReadOnly")
              : t("channel.onekey"),
        },
        {
          label: t("channel.row.discard"),
          channel: ch("trust.proposal.drop"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "edges": {
      const id = safeId(String((entry.item as EdgeProposal).id ?? ""));
      rail = cliAvailable && id !== "?" ? (
        <>
          {stampOk("inbox.edgeAccept", "stamp.en.accept", t("inbox.via.cliEdge"), () =>
            act(
              "/api/inbox/edge",
              { op: "accept", id },
              `edge.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `edge #${id}`),
            ),
          )}
          {stampDrop(
            "inbox.edgeReject",
            "stamp.en.reject",
            t("inbox.via.cliEdge"),
            (dropRun = () =>
              act(
                "/api/inbox/edge",
                { op: "reject", id },
                `edge.reject ${id}`,
                rejectedStamp,
                metaFor("stop", t("verdict.rejected"), `edge #${id}`),
              )),
          )}
        </>
      ) : (
        <CopyCommand
          command={edgeAcceptCommand(cliCommand, id)}
          hint={t("inbox.edgeHint")}
        />
      );
      rows = [
        {
          label: t("channel.row.accept"),
          channel: ch("edge-proposals.accept"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: t("channel.row.drop"),
          channel: ch("edge-proposals.reject"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "takes": {
      const take = entry.item as TakeProposal;
      const id = safeId(String(take.id));
      rail = cliAvailable ? (
        <>
          {stampOk("inbox.edgeAccept", "stamp.en.accept", t("inbox.via.cliTake"), () =>
            act(
              "/api/inbox/takes/propose",
              { op: "accept", id },
              `takes.propose.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `take #${id}`),
            ),
          )}
          {stampDrop(
            "inbox.drop",
            "stamp.en.reject",
            t("inbox.via.cliTake"),
            (dropRun = () =>
              act(
                "/api/inbox/takes/propose",
                { op: "reject", id },
                `takes.propose.reject ${id}`,
                rejectedStamp,
                metaFor("stop", t("verdict.rejected"), `take #${id}`),
              )),
          )}
        </>
      ) : (
        <CopyCommand
          command={takesAcceptCommand(cliCommand, id)}
          hint={t("inbox.takeHint")}
        />
      );
      rows = [
        {
          label: t("channel.row.accept"),
          channel: ch("takes.propose.accept"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: t("channel.row.drop"),
          channel: ch("takes.propose.reject"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    default: {
      // others: explain only — read path, no adjudication surface here
      const trust = entry.item as TrustReviewItem;
      rail = (
        <CopyCommand
          command={trustExplainCommand(cliCommand, safeRef(trust.ref))}
        />
      );
      rows = [
        { label: t("channel.row.explain"), channel: "cli-whitelist", verdict: "na", note: t("channel.terminal") },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
    }
  }

  // mockup keyboard affordances: ⌘⌫ = one-key drop (when the CLI channel is
  // live), ⌘↵ = copy the terminal-confirmation command. Both stay inert while
  // typing in inputs so they never eat editing keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (e.key === "Enter" && acceptCmd) {
        e.preventDefault();
        void copyCommandText(acceptCmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      } else if (e.key === "Backspace" && dropRun) {
        e.preventDefault();
        void dropRun();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="rail">
      <p className="cap">{t("inbox.rail.caption")}</p>
      {rail}
      <ChannelMatrixCard rows={rows} />
    </div>
  );
}
